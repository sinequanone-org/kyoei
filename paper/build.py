"""Build the paper PDF: pandoc to LaTeX, then XeLaTeX twice.

Usage, from the repository root:
    python3 paper/build.py
Writes paper/kyoei-repairable-collaboration.pdf. Logs go to paper/build/.
"""
from pathlib import Path
import subprocess

here = Path(__file__).resolve().parent
name = 'kyoei-repairable-collaboration'
out = here
work = here / 'build'
out.mkdir(parents=True, exist_ok=True)
work.mkdir(parents=True, exist_ok=True)
tex = work / 'paper.tex'
for figure_name in ('workflow-cycle', 'experiment-architecture'):
    figure = here / 'figures' / figure_name
    result = subprocess.run(['xelatex', '-interaction=nonstopmode', '-halt-on-error',
                             '-output-directory', str(work), str(figure.with_suffix('.latex'))],
                            cwd=here, text=True, capture_output=True)
    (work / (figure_name + '-build.txt')).write_text(result.stdout + result.stderr)
    if result.returncode:
        raise SystemExit(result.stdout[-4000:])
    figure.with_suffix('.pdf').write_bytes((work / (figure_name + '.pdf')).read_bytes())
    subprocess.run(['pdftoppm', '-singlefile', '-scale-to', '2200', '-png',
                    str(figure.with_suffix('.pdf')), str(figure)], check=True)
subprocess.run(['pandoc', str(here / 'paper.md'), '--standalone', '--number-sections',
                '--template', str(here / 'article.latex'), '--lua-filter', str(here / 'format.lua'),
                '-o', str(tex)], check=True)
for _ in range(2):
    result = subprocess.run(['xelatex', '-interaction=nonstopmode', '-halt-on-error',
                             '-output-directory', str(work), str(tex)],
                            cwd=here, text=True, capture_output=True)
    (work / 'build-output.txt').write_text(result.stdout + result.stderr)
    if result.returncode:
        raise SystemExit(result.stdout[-4000:])
(out / (name + '.pdf')).write_bytes((work / 'paper.pdf').read_bytes())
print(out / (name + '.pdf'))
