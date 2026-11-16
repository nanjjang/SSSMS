"""Train the presentation-attack (liveness) classifier and export to ONNX.

Data
 - real : LFW face crops (real photographs) + data/liveness/real/*.jpg collected at the kiosk
 - spoof: synthetic attacks generated on-the-fly from real crops (screen replay / printed photo)
          + data/liveness/spoof/*.jpg collected at the kiosk (phone screen, printed photo held to camera)
Collected samples are weighted higher because they match the kiosk camera domain.

usage: python train_liveness.py --epochs 20
"""
import argparse
import glob
import io
import json
import os
import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image
from models import LiveNet, count_params

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(ROOT, "data")
CKPT = os.path.join(ROOT, "checkpoints")
EXPORT = os.path.join(ROOT, "..", "public", "models")
S = 80  # model input size
rng = np.random.default_rng(0)


# ---------------- synthetic attack generator (numpy, HWC float 0..255) ----------------
def _grid(h, w):
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    return yy, xx


def screen_attack(img):
    """Face shown on a phone/monitor and re-captured: moire, subpixel grid, gamma, glare, blur."""
    h, w, _ = img.shape
    x = img.astype(np.float32)
    # display gamma / contrast / colour temperature
    x = 255 * (x / 255) ** rng.uniform(0.75, 1.3)
    x = x * rng.uniform(0.85, 1.15) + rng.uniform(-20, 25)
    x = x * np.array([rng.uniform(0.9, 1.0), rng.uniform(0.95, 1.05), rng.uniform(1.0, 1.15)])
    # moire: interference of display pixel grid and camera sensor grid
    yy, xx = _grid(h, w)
    for _ in range(rng.integers(1, 3)):
        f = rng.uniform(0.15, 0.9); a = rng.uniform(0, np.pi)
        pat = np.sin(2 * np.pi * f * (xx * np.cos(a) + yy * np.sin(a)) + rng.uniform(0, 6.28))
        x = x * (1 + rng.uniform(0.03, 0.12) * pat[..., None])
    # RGB subpixel stripes
    if rng.random() < 0.6:
        stripe = np.zeros((h, w, 3), np.float32)
        for c in range(3):
            stripe[:, c::3, c] = 1
        x = x * (1 - rng.uniform(0.04, 0.12)) + x * stripe * rng.uniform(0.08, 0.2)
    # specular glare
    if rng.random() < 0.6:
        cy, cx = rng.uniform(0, h), rng.uniform(0, w)
        r = rng.uniform(15, 60)
        glare = np.exp(-((yy - cy) ** 2 + (xx - cx) ** 2) / (2 * r * r))
        x = x + glare[..., None] * rng.uniform(40, 140)
    # bezel / screen edge visible
    if rng.random() < 0.25:
        side = rng.integers(0, 4); t = int(rng.uniform(3, 14))
        v = rng.uniform(0, 40)
        if side == 0: x[:t] = v
        elif side == 1: x[-t:] = v
        elif side == 2: x[:, :t] = v
        else: x[:, -t:] = v
    return x


def print_attack(img):
    """Printed photo held to the camera: halftone, desaturation, paper tint/texture, flat lighting."""
    h, w, _ = img.shape
    x = img.astype(np.float32)
    g = x.mean(2, keepdims=True)
    x = g + (x - g) * rng.uniform(0.55, 0.9)                       # ink gamut -> less saturation
    x = x * rng.uniform(0.75, 0.95) + np.array([rng.uniform(5, 25), rng.uniform(5, 20), rng.uniform(-10, 5)])
    yy, xx = _grid(h, w)
    period = rng.uniform(2.2, 4.5); ang = rng.uniform(0, np.pi / 2)
    u = xx * np.cos(ang) - yy * np.sin(ang); v = xx * np.sin(ang) + yy * np.cos(ang)
    dots = (np.cos(2 * np.pi * u / period) * np.cos(2 * np.pi * v / period))
    x = x * (1 + rng.uniform(0.05, 0.15) * dots[..., None])
    x = x + rng.normal(0, rng.uniform(2, 7), size=(h, w, 1))      # paper grain
    # flat lighting gradient across the sheet
    gy = (yy / h - 0.5) * rng.uniform(-40, 40) + (xx / w - 0.5) * rng.uniform(-40, 40)
    return x + gy[..., None]


def recapture(x):
    """Common re-capture degradations: blur, resize, JPEG."""
    x = np.clip(x, 0, 255).astype(np.uint8)
    im = Image.fromarray(x)
    if rng.random() < 0.7:
        k = int(rng.uniform(28, 64)); im = im.resize((k, k), Image.BILINEAR).resize((x.shape[1], x.shape[0]), Image.BILINEAR)
    if rng.random() < 0.8:
        b = io.BytesIO(); im.save(b, "JPEG", quality=int(rng.uniform(35, 85))); im = Image.open(b).convert("RGB")
    return np.asarray(im)


def real_aug(x):
    """Apply the *same* camera degradations to some real samples so the model can't cheat on blur/JPEG alone."""
    x = x.astype(np.float32) * rng.uniform(0.8, 1.2) + rng.uniform(-25, 25)
    x = np.clip(x, 0, 255).astype(np.uint8)
    im = Image.fromarray(x)
    if rng.random() < 0.5:
        k = int(rng.uniform(40, 112)); im = im.resize((k, k), Image.BILINEAR).resize((x.shape[1], x.shape[0]), Image.BILINEAR)
    if rng.random() < 0.6:
        b = io.BytesIO(); im.save(b, "JPEG", quality=int(rng.uniform(40, 95))); im = Image.open(b).convert("RGB")
    return np.asarray(im)


def to_input(img):
    im = Image.fromarray(np.clip(img, 0, 255).astype(np.uint8)).resize((S, S), Image.BILINEAR)
    return np.asarray(im)


def load_collected(label):
    files = sorted(glob.glob(os.path.join(DATA, "liveness", label, "*.jpg")) + glob.glob(os.path.join(DATA, "liveness", label, "*.png")))
    return [np.asarray(Image.open(f).convert("RGB").resize((112, 112), Image.BILINEAR)) for f in files]


def make_batch(reals, coll_real, coll_spoof, bs):
    xs, ys = [], []
    for _ in range(bs):
        r = rng.random()
        if coll_spoof and r < 0.15:
            img = coll_spoof[rng.integers(len(coll_spoof))]; xs.append(real_aug(img)); ys.append(0)
        elif coll_real and r < 0.30:
            img = coll_real[rng.integers(len(coll_real))]; xs.append(real_aug(img)); ys.append(1)
        elif r < 0.65:
            img = reals[rng.integers(len(reals))]
            att = screen_attack(img) if rng.random() < 0.55 else print_attack(img)
            xs.append(recapture(att)); ys.append(0)
        else:
            img = reals[rng.integers(len(reals))]; xs.append(real_aug(img)); ys.append(1)
    X = np.stack([to_input(x) for x in xs])
    if rng.random() < 0.5:
        X = X[:, :, ::-1]
    return X, np.array(ys)


def t(x, device):
    return ((torch.from_numpy(np.ascontiguousarray(x)).to(device).permute(0, 3, 1, 2).contiguous().float()) - 127.5) / 128.0


def export_onnx(model, path):
    model = model.to("cpu").eval()
    torch.onnx.export(model, torch.randn(1, 3, S, S), path, input_names=["input"], output_names=["logits"],
                      dynamic_axes={"input": {0: "n"}, "logits": {0: "n"}}, opset_version=17, dynamo=False)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--epochs", type=int, default=20)
    ap.add_argument("--steps", type=int, default=300)
    ap.add_argument("--bs", type=int, default=128)
    args = ap.parse_args()
    device = torch.device("mps" if torch.backends.mps.is_available() else "cpu")

    lfw = np.load(os.path.join(DATA, "lfw_x.npy"), mmap_mode="r")
    all_real = np.concatenate([lfw[:, 0], lfw[:, 1]])  # 12,000 real face crops
    celeba = os.path.join(DATA, "celeba_live_x.npy")
    if os.path.exists(celeba):  # + CelebA aligned faces (same 5-point alignment as the kiosk)
        all_real = np.concatenate([all_real, np.load(celeba)])
    idx = rng.permutation(len(all_real))
    nval = 1500
    train_real, val_real = all_real[idx[nval:]], all_real[idx[:nval]]
    coll_real, coll_spoof = load_collected("real"), load_collected("spoof")
    print(f"device={device} real(LFW)={len(train_real)} collected real={len(coll_real)} spoof={len(coll_spoof)}")

    # fixed validation set: held-out LFW reals + synthetic attacks on them (+ collected, if any)
    vx, vy = [], []
    for img in val_real:
        vx.append(to_input(real_aug(img))); vy.append(1)
        att = screen_attack(img) if rng.random() < 0.5 else print_attack(img)
        vx.append(to_input(recapture(att))); vy.append(0)
    vx, vy = np.stack(vx), np.array(vy)

    model = LiveNet().to(device)
    print("LiveNet params:", count_params(model))
    opt = torch.optim.AdamW(model.parameters(), lr=2e-3, weight_decay=1e-3)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=3e-3, total_steps=args.epochs * args.steps)
    os.makedirs(CKPT, exist_ok=True); os.makedirs(EXPORT, exist_ok=True)
    best, log = 1e9, []
    for ep in range(args.epochs):
        model.train(); tl = 0
        for it in range(args.steps):
            X, Y = make_batch(train_real, coll_real, coll_spoof, args.bs)
            out = model(t(X, device))
            loss = F.cross_entropy(out, torch.from_numpy(Y).to(device), label_smoothing=0.05)
            opt.zero_grad(set_to_none=True); loss.backward(); opt.step(); sched.step()
            tl += loss.item()
        model.eval()
        with torch.no_grad():
            p = torch.cat([F.softmax(model(t(vx[i:i + 512], device)), 1)[:, 1].cpu() for i in range(0, len(vx), 512)]).numpy()
        # APCER: attacks accepted as real, BPCER: real users rejected (ISO/IEC 30107-3 metrics) at 0.5
        apcer = float((p[vy == 0] >= 0.5).mean()); bpcer = float((p[vy == 1] < 0.5).mean()); acer = (apcer + bpcer) / 2
        log.append({"epoch": ep, "loss": tl / args.steps, "APCER": apcer, "BPCER": bpcer, "ACER": acer})
        print(f"== epoch {ep}: loss {tl / args.steps:.4f} | APCER {apcer:.4f} BPCER {bpcer:.4f} ACER {acer:.4f}", flush=True)
        if acer <= best:
            best = acer; torch.save(model.state_dict(), os.path.join(CKPT, "livenet_best.pt"))
        json.dump(log, open(os.path.join(CKPT, "liveness_log.json"), "w"), indent=1)

    model.load_state_dict(torch.load(os.path.join(CKPT, "livenet_best.pt")))
    export_onnx(model, os.path.join(EXPORT, "livenet.onnx"))
    meta = {"name": "sssms-livenet", "input": [1, 3, S, S], "norm": "(x-127.5)/128", "output": "logits[spoof, real]",
            "crop": "aligned 112x112 face resized to 80x80", "best_ACER": best,
            "collected_real": len(coll_real), "collected_spoof": len(coll_spoof),
            "note": "synthetic-attack baseline; retrain after collecting kiosk samples"}
    json.dump(meta, open(os.path.join(EXPORT, "livenet.json"), "w"), indent=1)
    print("exported", meta)


if __name__ == "__main__":
    main()
