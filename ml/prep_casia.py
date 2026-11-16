"""CASIA-WebFace (InsightFace MXNet RecordIO, 112x112 ArcFace-aligned) -> numpy, without MXNet.

RecordIO record layout: uint32 magic(0xced7230a) | uint32 lrec (low 29 bits = length) | payload (padded to 4 bytes)
payload = IRHeader{uint32 flag, float32 label, uint64 id, uint64 id2} [+ flag*float32 labels] + JPEG bytes
Record 0 is a meta header (flag=2: label range). train.idx lists "index<TAB>byte-offset".

Also converts InsightFace eval .bin files (pickle of (jpeg_bytes_list, issame_list)) to numpy pairs.
outputs: data/casia_x.npy (N,112,112,3) uint8, data/casia_y.npy, data/eval_<name>_x.npy (P,2,112,112,3), data/eval_<name>_y.npy
"""
import io
import os
import pickle
import struct
import sys
import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(ROOT, "data", "raw", "casia")
OUT = os.path.join(ROOT, "data")
MAGIC = 0xCED7230A


def read_record(f, off):
    f.seek(off)
    magic, lrec = struct.unpack("<II", f.read(8))
    assert magic == MAGIC, f"bad magic at {off}"
    length = lrec & ((1 << 29) - 1)
    payload = f.read(length)
    flag, label, _id, _id2 = struct.unpack("<IfQQ", payload[:24])
    p = 24
    if flag > 0:
        labels = struct.unpack(f"<{flag}f", payload[p:p + 4 * flag]); p += 4 * flag
        label = labels[0]
    return flag, label, payload[p:]


def decode(b):
    im = Image.open(io.BytesIO(b)).convert("RGB")
    if im.size != (112, 112):
        im = im.resize((112, 112), Image.BILINEAR)
    return np.asarray(im)


def prep_train():
    idx = []
    with open(os.path.join(RAW, "casia-webface", "train.idx")) as fh:
        for line in fh:
            k, off = line.split("\t"); idx.append((int(k), int(off)))
    idx.sort()
    offsets = dict(idx)
    with open(os.path.join(RAW, "casia-webface", "train.rec"), "rb") as f:
        img_keys = [k for k, _ in idx if k != 0]
        flag = read_record(f, offsets[0])[0] if 0 in offsets else 0
        # some packs start with a meta record (flag=2, label range); this one starts directly at 1
        if flag == 2:
            f.seek(offsets[0]); _m, lrec = struct.unpack("<II", f.read(8)); payload = f.read(lrec & ((1 << 29) - 1))
            start, end = struct.unpack("<2f", payload[24:32])
            img_keys = list(range(1, int(start)))
        N = len(img_keys)
        print(f"CASIA records: {N}", flush=True)
        X = np.lib.format.open_memmap(os.path.join(OUT, "casia_x.npy"), mode="w+", dtype=np.uint8, shape=(N, 112, 112, 3))
        Y = np.zeros(N, np.int32)
        for i, k in enumerate(img_keys):
            _f, lab, img = read_record(f, offsets[k])
            X[i] = decode(img); Y[i] = int(lab)
            if i % 50000 == 0:
                print(f"  {i}/{N}", flush=True)
        X.flush()
    # remap labels to 0..C-1
    _, Y = np.unique(Y, return_inverse=True)
    np.save(os.path.join(OUT, "casia_y.npy"), Y.astype(np.int32))
    print("identities:", Y.max() + 1)


def prep_eval(names=("lfw", "cfp_fp", "agedb_30")):
    for name in names:
        with open(os.path.join(RAW, "eval", f"{name}.bin"), "rb") as fh:
            bins, issame = pickle.load(fh, encoding="bytes")
        n = len(issame)
        X = np.zeros((n, 2, 112, 112, 3), np.uint8)
        for i in range(n):
            X[i, 0], X[i, 1] = decode(bins[2 * i]), decode(bins[2 * i + 1])
        np.save(os.path.join(OUT, f"eval_{name}_x.npy"), X)
        np.save(os.path.join(OUT, f"eval_{name}_y.npy"), np.array(issame, np.int8))
        print(f"eval {name}: {n} pairs, same={np.mean(issame):.2f}")


if __name__ == "__main__":
    what = sys.argv[1:] or ["eval", "train"]
    if "eval" in what:
        prep_eval()
    if "train" in what:
        prep_train()
