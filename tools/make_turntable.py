"""Раскладывает ролик-«вертушку» (объект на белом фоне, полный оборот) на кадры с прозрачным фоном.

    python tools/make_turntable.py <video.mp4> <id> [кадров=60] [glass]

glass — для прозрачного объекта: белое убирается везде, а не только снаружи контура.

Пишет img/turn/<id>/NNN.webp и печатает строку turn: {...} для data.js.
"""
import sys, os, json
import numpy as np, cv2
from PIL import Image

video, pid = sys.argv[1], sys.argv[2]
want = int(sys.argv[3]) if len(sys.argv) > 3 and sys.argv[3].isdigit() else 0   # 0 — все кадры ролика
GLASS = "glass" in sys.argv[3:]
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
out = os.path.join(root, "img", "turn", pid)
os.makedirs(out, exist_ok=True)
for old in os.listdir(out): os.remove(os.path.join(out, old))

cap = cv2.VideoCapture(video)
frames = []
while True:
    ok, f = cap.read()
    if not ok: break
    frames.append(cv2.cvtColor(f, cv2.COLOR_BGR2RGB))
total = len(frames)
# последний кадр равен первому — в петлю его не берём
# Берём кадры ролика подряд: дробный шаг (например 80 из 120) даёт неровный ход — то один, то два кадра.
if not want or want >= total - 1:
    want = total - 1
    idx = list(range(want))
else:
    stride = max(1, (total - 1) // want)
    idx = list(range(0, total - 1, stride)); want = len(idx)

def cut(im):
    im = im.astype(np.float32)
    h, w, _ = im.shape
    # фон берём по рамке кадра: модель не всегда даёт чисто белый, бывает серый градиент
    band = max(24, h // 14)
    m = np.zeros((h, w), bool); m[:band] = m[-band:] = True; m[:, :band] = m[:, -band:] = True
    yy, xx = np.mgrid[0:h, 0:w]
    X = np.stack([np.ones_like(xx), xx / w, yy / h, (xx / w) ** 2, (yy / h) ** 2, xx * yy / (w * h)], -1).astype(np.float32)
    white = np.median(im[m], axis=0).min() >= 250
    if white:
        bg = np.full((h, w, 3), 255.0, np.float32)
    else:
        bg = np.zeros((h, w, 3), np.float32)
        for c in range(3):
            sel = m.copy()
            for _ in range(3):   # подгонка плоскости фона с отбрасыванием выбросов (объект, тень)
                coef, *_ = np.linalg.lstsq(X[sel], im[..., c][sel], rcond=None)
                fit = X @ coef
                sel = m & (np.abs(im[..., c] - fit) < 10)
                if sel.sum() < 500: sel = m; break
            bg[..., c] = fit
        bg = np.clip(bg, 1, 255)
    floor = 0.03 if white else 0.12
    lo = (bg - im) / np.maximum(bg, 1); hi = (im - bg) / np.maximum(255 - bg, 24)
    a = np.clip(np.maximum(lo, hi).max(axis=2), 0, 1)
    low = (a < 0.38).astype(np.uint8)
    n, lab, st, _ = cv2.connectedComponentsWithStats(low, connectivity=4)
    edge = set(np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]])))
    keep = np.array([i > 0 and (i in edge or st[i, cv2.CC_STAT_AREA] > 900) for i in range(n)])
    region = cv2.dilate(keep[lab].astype(np.uint8), np.ones((5, 5), np.uint8)) > 0
    if GLASS:
        region = np.ones((h, w), bool)
        alpha = np.clip((a - floor) * 2.4, 0, 1)
    else:
        alpha = np.where(region, np.clip((a - floor) / (1 - floor), 0, 1), 1.0)
    solid = (alpha > 0.25).astype(np.uint8)
    n3, lab3, st3, _ = cv2.connectedComponentsWithStats(solid, connectivity=8)
    areas = st3[:, cv2.CC_STAT_AREA].copy(); areas[0] = 0
    ok = cv2.dilate((areas >= 0.08 * areas.max())[lab3].astype(np.uint8), np.ones((41, 41), np.uint8)) > 0
    alpha = np.where(ok, alpha, 0.0)
    aa = np.maximum(alpha, 1e-3)[..., None]
    col = np.clip(np.where(region[..., None], (im - bg * (1 - aa)) / aa, im), 0, 255)
    return np.dstack([col, alpha * 255]).astype(np.uint8)

cuts = [cut(frames[i]) for i in idx]

# Модель иногда «перескакивает» между соседними кадрами (чаще в конце, подгоняя последний кадр под первый).
def premul(c):
    c = c.astype(np.float32); c[..., :3] *= c[..., 3:] / 255; return c
small = [cv2.resize(premul(c), (160, 120), interpolation=cv2.INTER_AREA) for c in cuts]
step = np.array([np.abs(small[k] - small[(k + 1) % want]).mean() for k in range(want)])
med = np.median(step)
# скачок — одиночный всплеск: заметно больше и общего уровня, и соседних шагов
jumps = [int(k) for k in range(want) if step[k] > 3.2 * med
         and step[k] > 2.2 * max(step[(k - 2) % want], step[(k + 2) % want])]
# Скачки только отмечаем в отчёте. Растворять их нельзя: смесь двух разных поз даёт полупрозрачный
# «призрак». Лечится перегенерацией ролика.

boxes = []
for c in cuts:
    ys, xs = np.where(c[..., 3] > 12)
    boxes.append((xs.min(), ys.min(), xs.max() + 1, ys.max() + 1))
b = np.array(boxes)
x0, y0, x1, y1 = b[:, 0].min(), b[:, 1].min(), b[:, 2].max(), b[:, 3].max()
for k, c in enumerate(cuts):
    Image.fromarray(c[y0:y1, x0:x1], "RGBA").save(os.path.join(out, f"{k:03d}.webp"), quality=74, method=5)

# рамка самого объекта (без тени) в нулевом кадре — по ней кадры совмещаются с вырезкой
ys, xs = np.where(cuts[0][..., 3] > (40 if GLASS else 200))
meta = {"dir": f"img/turn/{pid}", "n": want, "fw": int(x1 - x0), "fh": int(y1 - y0),
        "ox": int(xs.min() - x0), "oy": int(ys.min() - y0), "ow": int(xs.max() + 1 - xs.min()), "oh": int(ys.max() + 1 - ys.min())}
size = sum(os.path.getsize(os.path.join(out, f)) for f in os.listdir(out))
sys.stdout.reconfigure(encoding="utf-8")
print("turn:", json.dumps(meta), f"  // {size // 1024} КБ, исходных кадров {total}, скачки между кадрами: {jumps}")
