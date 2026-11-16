"""SSSMS face models.

FaceNet  : MobileFaceNet-style embedding network (112x112 RGB -> 128-d L2-normalized embedding)
ArcFace  : additive angular margin head used only during training
LiveNet  : small depthwise CNN for presentation-attack detection (80x80 RGB -> [spoof, real] logits)

Both networks are kept tiny (<1.2M params) so they run in the browser via onnxruntime-web (WASM/WebGPU).
"""
import math
import torch
import torch.nn as nn
import torch.nn.functional as F


class ConvBN(nn.Sequential):
    def __init__(self, cin, cout, k=3, s=1, p=1, groups=1, act=True):
        layers = [nn.Conv2d(cin, cout, k, s, p, groups=groups, bias=False), nn.BatchNorm2d(cout)]
        if act:
            layers.append(nn.PReLU(cout))
        super().__init__(*layers)


class Bottleneck(nn.Module):
    """Inverted residual (MobileNetV2) block."""

    def __init__(self, cin, cout, stride, expansion):
        super().__init__()
        mid = cin * expansion
        self.use_res = stride == 1 and cin == cout
        self.block = nn.Sequential(
            ConvBN(cin, mid, 1, 1, 0),
            ConvBN(mid, mid, 3, stride, 1, groups=mid),
            ConvBN(mid, cout, 1, 1, 0, act=False),
        )

    def forward(self, x):
        y = self.block(x)
        return x + y if self.use_res else y


def _stage(cin, cout, n, stride, t):
    layers = [Bottleneck(cin, cout, stride, t)]
    layers += [Bottleneck(cout, cout, 1, t) for _ in range(n - 1)]
    return nn.Sequential(*layers)


class FaceNet(nn.Module):
    """MobileFaceNet (Chen et al. 2018), slightly reduced. Input: (N,3,112,112) in [-1,1]."""

    def __init__(self, emb=128):
        super().__init__()
        self.stem = nn.Sequential(ConvBN(3, 64, 3, 2, 1), ConvBN(64, 64, 3, 1, 1, groups=64))  # 56
        self.body = nn.Sequential(
            _stage(64, 64, 4, 2, 2),    # 28
            _stage(64, 128, 1, 2, 4),   # 14
            _stage(128, 128, 5, 1, 2),
            _stage(128, 128, 1, 2, 4),  # 7
            _stage(128, 128, 2, 1, 2),
        )
        self.conv_last = ConvBN(128, 512, 1, 1, 0)
        self.gdc = ConvBN(512, 512, 7, 1, 0, groups=512, act=False)  # global depthwise conv -> 1x1
        self.fc = nn.Sequential(nn.Conv2d(512, emb, 1, bias=False), nn.BatchNorm2d(emb))

    def forward(self, x):
        x = self.conv_last(self.body(self.stem(x)))
        x = self.fc(self.gdc(x)).flatten(1)
        return F.normalize(x, dim=1)


class ArcFace(nn.Module):
    """Additive angular margin loss head (Deng et al. 2019)."""

    def __init__(self, emb, n_classes, s=64.0, m=0.5):
        super().__init__()
        self.W = nn.Parameter(torch.empty(n_classes, emb))
        nn.init.xavier_uniform_(self.W)
        self.s, self.m = s, m
        self.cos_m, self.sin_m = math.cos(m), math.sin(m)
        self.th, self.mm = math.cos(math.pi - m), math.sin(math.pi - m) * m

    def forward(self, emb, labels):
        cos = F.linear(emb, F.normalize(self.W)).clamp(-1 + 1e-7, 1 - 1e-7)
        sin = torch.sqrt(1.0 - cos * cos)
        phi = cos * self.cos_m - sin * self.sin_m
        phi = torch.where(cos > self.th, phi, cos - self.mm)
        onehot = F.one_hot(labels, cos.size(1)).to(cos.dtype)
        logits = self.s * (onehot * phi + (1 - onehot) * cos)
        return F.cross_entropy(logits, labels), cos


class CosFace(nn.Module):
    """Large-margin cosine loss (Wang et al. 2018): logit = s*(cos - m) for the target class.
    More stable than ArcFace when training a small network from scratch (no angular-margin cliff)."""

    def __init__(self, emb, n_classes, s=64.0, m=0.35):
        super().__init__()
        self.W = nn.Parameter(torch.empty(n_classes, emb))
        nn.init.xavier_uniform_(self.W)
        self.s, self.m = s, m

    def forward(self, emb, labels):
        cos = F.linear(emb, F.normalize(self.W)).clamp(-1, 1)
        onehot = F.one_hot(labels, cos.size(1)).to(cos.dtype)
        logits = self.s * (cos - onehot * self.m)
        return F.cross_entropy(logits, labels), cos


class LiveNet(nn.Module):
    """Tiny anti-spoof classifier with an auxiliary high-frequency texture branch.

    Spoof media (screens, prints) leave high-frequency artefacts (moire, halftone, re-capture blur),
    so we feed both RGB and a Laplacian high-pass of the grayscale crop.
    Input: (N,3,80,80) in [-1,1]. Output logits (N,2): index 1 = real.
    """

    def __init__(self):
        super().__init__()
        self.rgb = nn.Sequential(
            ConvBN(3, 32, 3, 2, 1),            # 40
            Bottleneck(32, 32, 1, 2),
            Bottleneck(32, 64, 2, 4),          # 20
            Bottleneck(64, 64, 1, 2),
            Bottleneck(64, 128, 2, 4),         # 10
            Bottleneck(128, 128, 1, 2),
            Bottleneck(128, 128, 2, 2),        # 5
            ConvBN(128, 256, 1, 1, 0),
        )
        self.freq = nn.Sequential(ConvBN(1, 16, 3, 2, 1), ConvBN(16, 32, 3, 2, 1), ConvBN(32, 64, 3, 2, 1))
        self.head = nn.Sequential(nn.Dropout(0.3), nn.Linear(256 + 64, 2))

        # fixed high-pass (Laplacian) filter: isolates fine texture where moire/halftone/re-capture artefacts live.
        # (Used instead of an FFT so the whole graph exports to ONNX for onnxruntime-web.)
        lap = torch.tensor([[0, -1, 0], [-1, 4, -1], [0, -1, 0]], dtype=torch.float32).view(1, 1, 3, 3)
        self.register_buffer("lap", lap)

    def highpass(self, x):
        g = (0.299 * x[:, 0:1] + 0.587 * x[:, 1:2] + 0.114 * x[:, 2:3])
        h = F.conv2d(g, self.lap, padding=1)
        return h / (h.abs().mean(dim=(2, 3), keepdim=True) + 1e-3)

    def forward(self, x):
        a = F.adaptive_avg_pool2d(self.rgb(x), 1).flatten(1)
        b = F.adaptive_avg_pool2d(self.freq(self.highpass(x)), 1).flatten(1)
        return self.head(torch.cat([a, b], 1))


def count_params(m):
    return sum(p.numel() for p in m.parameters())


if __name__ == "__main__":
    f, l = FaceNet(), LiveNet()
    print("FaceNet params", count_params(f), f(torch.randn(2, 3, 112, 112)).shape)
    print("LiveNet params", count_params(l), l(torch.randn(2, 3, 80, 80)).shape)
