"""What minerva-fs's own functions answer for cases the TypeScript tests choose, so they can be compared with
pi's and today's (test/unit/sandbox-python.test.ts): line scans (pi's LineScanner), the manifest policy for a
name (worker/src/folder.ts refusedPath) and the display of a skipped path (displayPath).

    python3 -I vectors.py < cases.json > answers.json

`cases.json` is {"scans": [{"hex", "start", "end"}], "paths": [str], "displays": [hex]}."""

import importlib.machinery
import importlib.util
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
loader = importlib.machinery.SourceFileLoader("minerva_fs", os.path.join(HERE, "..", "minerva", "minerva-fs"))
spec = importlib.util.spec_from_loader("minerva_fs", loader)
fs = importlib.util.module_from_spec(spec)
loader.exec_module(fs)

cases = json.load(sys.stdin)
answers = {"scans": [], "paths": [], "displays": []}
for case in cases["scans"]:
    try:
        scanner = fs.LineScanner(case["start"], case.get("end"))
    except ValueError:
        answers["scans"].append(None)
        continue
    data = bytes.fromhex(case["hex"])
    # Fed in pieces, as the reader feeds a file, so chunk boundaries are tested too.
    step = case.get("chunk") or 64 * 1024
    for at in range(0, len(data), step):
        scanner.push(data[at : at + step])
    answers["scans"].append(scanner.finish())
for path in cases["paths"]:
    answers["paths"].append(fs.refused_path(path))
for key in cases["displays"]:
    answers["displays"].append(fs.display_path(bytes.fromhex(key)))
json.dump(answers, sys.stdout, ensure_ascii=True)
