"""Decode raw datasets into fast uint8 numpy arrays.

DigiFace-1M (synthetic, already ArcFace-aligned 112x112 RGBA) -> data/digi_x.npy (N,112,112,3), data/digi_y.npy
LFW 10-fold pairs (real photos, 250x250, face centred)        -> data/lfw_x.npy  (6000,2,112,112,3), data/lfw_y.npy
"""
import io
import os
import sys
import zipfile
import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(ROOT, "data", "raw")
OUT = os.path.join(ROOT, "data")


def rgba_to_rgb(im, rng):
    """DigiFace renders have a transparent background; composite onto a random flat/noisy colour."""
    if im.mode != "RGBA":
        return np.asarray(im.convert("RGB"))
    a = np.asarray(im).astype(np.float32)
    bg = np.ones((112, 112, 3), np.float32) * rng.integers(40, 220, size=3)
    alpha = a[..., 3:4] / 255.0
    return (a[..., :3] * alpha + bg * (1 - alpha)).clip(0, 255).astype(np.uint8)


def prep_digiface():
    zips = sorted(f for f in os.listdir(RAW) if f.startswith("subjects_") and f.endswith(".zip"))
    entries = []
    for z in zips:
        with zipfile.ZipFile(os.path.join(RAW, z)) as zf:
            entries += [(z, n) for n in zf.namelist() if n.endswith(".png")]
    ids = sorted({int(n.split("/")[0]) for _, n in entries})
    remap = {k: i for i, k in enumerate(ids)}
    N = len(entries)
    print(f"DigiFace: {N} images, {len(ids)} identities")
    X = np.lib.format.open_memmap(os.path.join(OUT, "digi_x.npy"), mode="w+", dtype=np.uint8, shape=(N, 112, 112, 3))
    Y = np.zeros(N, np.int32)
    rng = np.random.default_rng(0)
    i = 0
    for z in zips:
        with zipfile.ZipFile(os.path.join(RAW, z)) as zf:
            for n in (n for zz, n in entries if zz == z):
                im = Image.open(io.BytesIO(zf.read(n)))
                if im.size != (112, 112):
                    im = im.resize((112, 112), Image.BILINEAR)
                X[i] = rgba_to_rgb(im, rng)
                Y[i] = remap[int(n.split("/")[0])]
                i += 1
                if i % 20000 == 0:
                    print(f"  {i}/{N}", flush=True)
    X.flush()
    np.save(os.path.join(OUT, "digi_y.npy"), Y)


def lfw_crop(img):
    # LFW 250x250 images are roughly centred on the face; this crop approximates ArcFace framing.
    c = img[58:196, 56:194]
    return np.asarray(Image.fromarray(c.astype(np.uint8)).resize((112, 112), Image.BILINEAR))


def prep_lfw():
    from sklearn.datasets import fetch_lfw_pairs
    p = fetch_lfw_pairs(subset="10_folds", color=True, resize=1.0, slice_=None, data_home=os.path.join(RAW, "lfw"))
    pairs = p.pairs  # (6000,2,250,250,3) float
    if pairs.max() <= 1.0:
        pairs = pairs * 255.0
    X = np.zeros((len(pairs), 2, 112, 112, 3), np.uint8)
    for i, (a, b) in enumerate(pairs):
        X[i, 0], X[i, 1] = lfw_crop(a), lfw_crop(b)
    np.save(os.path.join(OUT, "lfw_x.npy"), X)
    np.save(os.path.join(OUT, "lfw_y.npy"), p.target.astype(np.int8))
    print("LFW pairs", X.shape)


if __name__ == "__main__":
    what = sys.argv[1:] or ["digi", "lfw"]
    if "lfw" in what:
        prep_lfw()
    if "digi" in what:
        prep_digiface()
