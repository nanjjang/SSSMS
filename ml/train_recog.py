"""Train the face-recognition embedding network (FaceNet + ArcFace) and export to ONNX.

Train data : DigiFace-1M subset (synthetic identities, data/digi_x.npy)
Eval data  : LFW 6,000 pairs, 10-fold verification accuracy (real photos, never used for training)

usage: python train_recog.py --epochs 16 --bs 256
"""
import argparse
import json
import os
import time
import numpy as np
import torch
import torch.nn.functional as F
from models import FaceNet, ArcFace, CosFace, count_params

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(ROOT, "data")
CKPT = os.path.join(ROOT, "checkpoints")
EXPORT = os.path.join(ROOT, "..", "public", "models")


def to_tensor(x_uint8, device):
    x = torch.from_numpy(np.ascontiguousarray(x_uint8)).to(device).permute(0, 3, 1, 2).float()
    return (x - 127.5) / 128.0


def augment(x):
    """GPU batch augmentation to close the synthetic->real gap. x: (N,3,112,112) in [-1,1]."""
    n = x.size(0)
    dev = x.device
    # horizontal flip
    flip = torch.rand(n, device=dev) < 0.5
    x = torch.where(flip.view(-1, 1, 1, 1), x.flip(3), x)
    # random resized crop / translate (small) via affine grid
    s = 1 + (torch.rand(n, device=dev) - 0.5) * 0.2
    tx, ty = (torch.rand(n, device=dev) - 0.5) * 0.12, (torch.rand(n, device=dev) - 0.5) * 0.12
    rot = (torch.rand(n, device=dev) - 0.5) * 0.25
    th = torch.zeros(n, 2, 3, device=dev)
    th[:, 0, 0], th[:, 0, 1], th[:, 0, 2] = torch.cos(rot) / s, -torch.sin(rot) / s, tx
    th[:, 1, 0], th[:, 1, 1], th[:, 1, 2] = torch.sin(rot) / s, torch.cos(rot) / s, ty
    x = F.grid_sample(x, F.affine_grid(th, x.shape, align_corners=False), padding_mode="reflection", align_corners=False)
    # colour: brightness / contrast / saturation / per-channel gain
    b = (torch.rand(n, 1, 1, 1, device=dev) - 0.5) * 0.5
    c = 1 + (torch.rand(n, 1, 1, 1, device=dev) - 0.5) * 0.6
    g = x.mean(1, keepdim=True)
    sat = 1 + (torch.rand(n, 1, 1, 1, device=dev) - 0.5) * 0.8
    gain = 1 + (torch.rand(n, 3, 1, 1, device=dev) - 0.5) * 0.15
    x = ((g + (x - g) * sat) * c + b) * gain
    gray = torch.rand(n, device=dev) < 0.1
    x = torch.where(gray.view(-1, 1, 1, 1), x.mean(1, keepdim=True).expand_as(x), x)
    # blur (down-up sample) to mimic low-res webcams
    blur = torch.rand(n, device=dev) < 0.3
    if blur.any():
        k = int(np.random.choice([40, 56, 72]))
        xb = F.interpolate(F.interpolate(x[blur], size=k, mode="bilinear", align_corners=False), size=112, mode="bilinear", align_corners=False)
        x[blur] = xb
    # sensor noise
    x = x + torch.randn_like(x) * (torch.rand(n, 1, 1, 1, device=dev) * 0.06)
    return x.clamp(-1, 1)


@torch.no_grad()
def embed(model, X, device, bs=512, tta=True):
    out = []
    for i in range(0, len(X), bs):
        x = to_tensor(X[i:i + bs], device)
        e = model(x)
        if tta:
            e = F.normalize(e + model(x.flip(3)), dim=1)
        out.append(e.cpu())
    return torch.cat(out).numpy()


def lfw_eval(model, device, name="lfw"):
    """Standard 10-fold verification protocol: pick the best threshold on 9 folds, test on the held-out one.
    name: 'lfw' (official InsightFace aligned pairs if available), 'cfp_fp', 'agedb_30'."""
    fx = os.path.join(DATA, f"eval_{name}_x.npy")
    if not os.path.exists(fx):
        fx = os.path.join(DATA, "lfw_x.npy")
    X = np.load(fx, mmap_mode="r")
    y = np.load(fx.replace("_x.npy", "_y.npy")).astype(bool)
    model.eval()
    a = embed(model, X[:, 0], device)
    b = embed(model, X[:, 1], device)
    sims = (a * b).sum(1)
    folds = np.array_split(np.arange(len(y)), 10)
    accs, ths = [], []
    cand = np.linspace(-0.2, 1.0, 241)
    for k in range(10):
        test = folds[k]
        train = np.concatenate([folds[j] for j in range(10) if j != k])
        best = cand[np.argmax([((sims[train] > t) == y[train]).mean() for t in cand])]
        ths.append(best)
        accs.append(((sims[test] > best) == y[test]).mean())
    # TAR @ FAR=1% (security-oriented number for the kiosk)
    neg = np.sort(sims[~y])[::-1]
    t_far = neg[int(len(neg) * 0.01)]
    tar = (sims[y] > t_far).mean()
    lfw_eval.thr_far01 = float(neg[int(len(neg) * 0.001)])  # FAR=0.1% 기준: 서버 1:N 매칭이 사용
    return float(np.mean(accs)), float(np.mean(ths)), float(tar), float(t_far)


def export_onnx(model, path):
    model = model.to("cpu").eval()
    dummy = torch.randn(1, 3, 112, 112)
    torch.onnx.export(model, dummy, path, input_names=["input"], output_names=["embedding"],
                      dynamic_axes={"input": {0: "n"}, "embedding": {0: "n"}}, opset_version=17, dynamo=False)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--epochs", type=int, default=16)
    ap.add_argument("--bs", type=int, default=256)
    ap.add_argument("--lr", type=float, default=0.1)
    ap.add_argument("--limit", type=int, default=0, help="debug: use only N images")
    ap.add_argument("--data", default="casia", help="casia (real, CASIA-WebFace) or digi (synthetic DigiFace)")
    ap.add_argument("--loss", default="cosface", choices=["cosface", "arcface"])
    ap.add_argument("--init", default="", help="warm-start FaceNet weights (.pt)")
    ap.add_argument("--warm-epochs", type=float, default=1.0)
    ap.add_argument("--resume", default="", help="continue from checkpoints/recog_last.pt (model, head, optimizer, LR schedule)")
    args = ap.parse_args()

    device = torch.device("mps" if torch.backends.mps.is_available() else "cpu")
    X = np.load(os.path.join(DATA, f"{args.data}_x.npy"), mmap_mode="r")
    Y = np.load(os.path.join(DATA, f"{args.data}_y.npy"))
    if args.limit:
        idx = np.random.default_rng(0).choice(len(X), args.limit, replace=False)
        idx.sort(); X, Y = X[idx], Y[idx]
    n_cls = int(Y.max()) + 1
    print(f"device={device} images={len(X)} identities={n_cls}")

    model = FaceNet().to(device)
    if args.init:
        model.load_state_dict(torch.load(args.init, map_location="cpu")); print("init from", args.init)
    head = (CosFace(128, n_cls) if args.loss == "cosface" else ArcFace(128, n_cls)).to(device)
    print("FaceNet params:", count_params(model))
    params = [{"params": model.parameters(), "weight_decay": 5e-4}, {"params": head.parameters(), "weight_decay": 5e-4}]
    opt = torch.optim.SGD(params, lr=args.lr, momentum=0.9, nesterov=True)
    steps_per_epoch = len(X) // args.bs
    total = steps_per_epoch * args.epochs
    warm = max(1, int(steps_per_epoch * args.warm_epochs))
    sched = torch.optim.lr_scheduler.LambdaLR(opt, lambda s: min(1.0, (s + 1) / warm) * 0.5 * (1 + np.cos(np.pi * min(1.0, s / total))))

    os.makedirs(CKPT, exist_ok=True); os.makedirs(EXPORT, exist_ok=True)
    best = 0.0
    log = []
    start_ep = 0
    if args.resume:
        st = torch.load(args.resume, map_location="cpu", weights_only=False)  # our own checkpoint (scheduler state holds numpy scalars)
        model.load_state_dict(st["model"]); head.load_state_dict(st["head"])
        opt.load_state_dict(st["opt"]); sched.load_state_dict(st["sched"])
        start_ep = st["epoch"] + 1
        lp = os.path.join(CKPT, "recog_log.json")
        if os.path.exists(lp):
            log = [e for e in json.load(open(lp)) if e["epoch"] < start_ep]
            best = max((e["lfw_acc"] + e.get("cfp_fp", 0) + e.get("agedb_30", 0) for e in log), default=0.0)
        print(f"resume from epoch {start_ep} (best score so far {best:.4f})", flush=True)
    for ep in range(start_ep, args.epochs):
        model.train(); head.train()
        perm = np.random.permutation(len(X))
        t0 = time.time(); run_loss = run_acc = 0.0
        for it in range(steps_per_epoch):
            bi = np.sort(perm[it * args.bs:(it + 1) * args.bs])  # sorted -> faster memmap reads
            x = augment(to_tensor(X[bi], device))
            y = torch.from_numpy(Y[bi].astype(np.int64)).to(device)
            loss, cos = head(model(x), y)
            opt.zero_grad(set_to_none=True)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 5.0)
            opt.step(); sched.step()
            run_loss = 0.98 * run_loss + 0.02 * loss.item() if it else loss.item()
            if it % 50 == 0:
                run_acc = (cos.argmax(1) == y).float().mean().item()
            if it % 200 == 0:
                print(f"ep {ep} it {it}/{steps_per_epoch} loss {run_loss:.3f} train-acc {run_acc:.3f} lr {sched.get_last_lr()[0]:.4f} {time.time() - t0:.0f}s", flush=True)
        acc, th, tar, t_far = lfw_eval(model, device)
        cfp = lfw_eval(model, device, "cfp_fp")[0] if os.path.exists(os.path.join(DATA, "eval_cfp_fp_x.npy")) else 0.0
        age = lfw_eval(model, device, "agedb_30")[0] if os.path.exists(os.path.join(DATA, "eval_agedb_30_x.npy")) else 0.0
        log.append({"epoch": ep, "loss": run_loss, "lfw_acc": acc, "cfp_fp": cfp, "agedb_30": age, "threshold": th, "tar_far1": tar, "thr_far1": t_far})
        print(f"== epoch {ep}: LFW {acc:.4f} CFP-FP {cfp:.4f} AgeDB {age:.4f} (thr {th:.3f}) | TAR@FAR1% {tar:.4f} | {time.time() - t0:.0f}s", flush=True)
        score = acc + cfp + age
        if score > best:
            best = score
            torch.save(model.state_dict(), os.path.join(CKPT, "facenet_best.pt"))
        json.dump(log, open(os.path.join(CKPT, "recog_log.json"), "w"), indent=1)
        torch.save({"epoch": ep, "model": model.state_dict(), "head": head.state_dict(), "opt": opt.state_dict(), "sched": sched.state_dict()}, os.path.join(CKPT, "recog_last.pt"))
        torch.save(model.state_dict(), os.path.join(CKPT, f"facenet_ep{ep:02d}.pt"))

    model.load_state_dict(torch.load(os.path.join(CKPT, "facenet_best.pt")))
    acc, th, tar, t_far = lfw_eval(model, device)
    t_far01 = lfw_eval.thr_far01
    cfp = lfw_eval(model, device, "cfp_fp")[0] if os.path.exists(os.path.join(DATA, "eval_cfp_fp_x.npy")) else None
    age = lfw_eval(model, device, "agedb_30")[0] if os.path.exists(os.path.join(DATA, "eval_agedb_30_x.npy")) else None
    export_onnx(model, os.path.join(EXPORT, "facenet.onnx"))
    meta = {"name": "sssms-facenet", "input": [1, 3, 112, 112], "norm": "(x-127.5)/128", "embedding": 128,
            "metric": "cosine", "lfw_acc": acc, "cfp_fp_acc": cfp, "agedb_30_acc": age, "threshold_best_acc": th, "threshold_far1": t_far, "threshold_far01": t_far01, "tar_far1": tar,
            "train": "CASIA-WebFace (real, 10,572 ids, non-commercial research)" if args.data == "casia" else "DigiFace-1M subset (synthetic, non-commercial research)"}
    json.dump(meta, open(os.path.join(EXPORT, "facenet.json"), "w"), indent=1)
    print("exported", meta)


if __name__ == "__main__":
    main()
