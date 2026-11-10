"""Раскладывает ролики Video/turn_NN.mp4 на кадры и вписывает строки turn в data.js.

    python tools/build_turns.py            — все ролики
    python tools/build_turns.py 10 15      — только перечисленные объекты
"""
import os, re, subprocess, sys
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
video = os.path.join(os.path.dirname(os.path.dirname(root)), "Video")
data = os.path.join(root, "data.js")
only = sys.argv[1:]
src = open(data, encoding="utf-8").read()
for f in sorted(os.listdir(video)):
    m = re.fullmatch(r"turn_(\d\d)\.mp4", f)
    if not m or (only and m.group(1) not in only): continue
    pid = m.group(1)
    args = [sys.executable, "-I", os.path.join(root, "tools", "make_turntable.py"), os.path.join(video, f), pid]
    if pid == "09": args.append("glass")
    out = subprocess.run(args, capture_output=True, text=True, encoding="utf-8").stdout.strip()
    print(pid, out)
    meta = re.sub(r'"(\w+)":', r"\1:", re.search(r"turn: (\{.*?\})", out).group(1))
    head = rf'(id: "{pid}", img: [^\n]*)'
    src = re.sub(head + r"\n    turn: \{[^\n]*\},", r"\1", src)
    src, n = re.subn(head, lambda mm: mm.group(1) + "\n    turn: " + meta + ",", src)
    assert n == 1, pid
open(data, "w", encoding="utf-8").write(src)
