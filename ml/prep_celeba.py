"""CelebA (img_align_celeba + 5-point landmarks) -> ArcFace-aligned 112x112 real faces for liveness training.

The archive has no identity labels, so it is NOT used for recognition — only as diverse *real* faces
(the liveness model needs many genuine faces under varied lighting/pose to learn what a spoof is not).
The same 5-point similarity alignment as the kiosk (public/common/sssms-models.js) is used, so the crops match.
output: data/celeba_live_x.npy (N,112,112,3)
"""
import csv
import os
import sys
import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(ROOT, "data", "raw", "celeba")
OUT = os.path.join(ROOT, "data")
TEMPLATE = np.array([[38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366], [41.5493, 92.3655], [70.7299, 92.2041]], np.float64)


def similarity(src, dst):
    """Least-squares similarity transform src->dst; returns 2x3 [[a,-b,tx],[b,a,ty]]."""
    sm, dm = src.mean(0), dst.mean(0)
    s, d = src - sm, dst - dm
    den = (s ** 2).sum()
    a = (s[:, 0] * d[:, 0] + s[:, 1] * d[:, 1]).sum() / den
    b = (s[:, 0] * d[:, 1] - s[:, 1] * d[:, 0]).sum() / den
    return np.array([[a, -b, dm[0] - (a * sm[0] - b * sm[1])], [b, a, dm[1] - (b * sm[0] + a * sm[1])]])


def warp(img, M):
    # PIL wants the inverse map (output -> input)
    A = np.vstack([M, [0, 0, 1]])
    inv = np.linalg.inv(A)
    return img.transform((112, 112), Image.AFFINE, inv[:2].ravel().tolist(), resample=Image.BILINEAR)


def main(n=40000):
    rows = list(csv.DictReader(open(os.path.join(RAW, "list_landmarks_align_celeba.csv"))))
    rng = np.random.default_rng(0)
    pick = rng.choice(len(rows), min(n, len(rows)), replace=False)
    X = np.zeros((len(pick), 112, 112, 3), np.uint8)
    imgdir = os.path.join(RAW, "img_align_celeba", "img_align_celeba")
    for i, j in enumerate(pick):
        r = rows[j]
        pts = np.array([[float(r["lefteye_x"]), float(r["lefteye_y"])], [float(r["righteye_x"]), float(r["righteye_y"])],
                        [float(r["nose_x"]), float(r["nose_y"])], [float(r["leftmouth_x"]), float(r["leftmouth_y"])],
                        [float(r["rightmouth_x"]), float(r["rightmouth_y"])]])
        im = Image.open(os.path.join(imgdir, r["image_id"])).convert("RGB")
        X[i] = np.asarray(warp(im, similarity(pts, TEMPLATE)))
        if i % 10000 == 0:
            print(f"  {i}/{len(pick)}", flush=True)
    np.save(os.path.join(OUT, "celeba_live_x.npy"), X)
    print("CelebA aligned real faces:", X.shape)


if __name__ == "__main__":
    main(int(sys.argv[1]) if len(sys.argv) > 1 else 40000)
