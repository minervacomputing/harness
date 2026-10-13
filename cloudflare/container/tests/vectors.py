"""What minerva-fs's own functions answer for cases the TypeScript tests choose, so they can be compared with
the TypeScript ones (test/docker/sandbox-python.test.ts): the manifest policy for a path (refusedPath) and the
display of a skipped path (displayPath).

    python3 -I vectors.py < cases.json > answers.json

`cases.json` is {"paths": [str], "displays": [hex]}."""

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
answers = {"paths": [], "displays": []}
for path in cases["paths"]:
    answers["paths"].append(fs.refused_path(path))
for key in cases["displays"]:
    answers["displays"].append(fs.display_path(bytes.fromhex(key)))
json.dump(answers, sys.stdout, ensure_ascii=True)
