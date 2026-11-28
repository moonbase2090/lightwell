import csv
import io
import json
import os
from pathlib import Path
import subprocess as sp
import sys
import time

mode, binary, output = sys.argv[1:]
out = Path(output).resolve()
out.mkdir(parents=True, exist_ok=True)
env = os.environ.copy()
env['GSETTINGS_BACKEND'] = 'memory'
for kind in ('config', 'data', 'cache', 'runtime'):
    directory = out / kind
    directory.mkdir(exist_ok=True, mode=0o700)
    env['XDG_' + kind.upper() + ('_DIR' if kind == 'runtime' else '_HOME')] = str(directory)
if mode == 'fallback':
    env['DBUS_SESSION_BUS_ADDRESS'] = 'unix:path=/tmp/lightwell-missing-bus'

def run(*args):
    return sp.check_output(args, text=True, stderr=sp.DEVNULL, timeout=10).strip()

def key(*keys):
    run('xdotool', 'key', '--clearmodifiers', *keys)

def window(title):
    deadline = time.monotonic() + 45
    while time.monotonic() < deadline:
        try:
            return run('xdotool', 'search', '--onlyvisible', '--name', '^' + title + '$').splitlines()[0]
        except (sp.CalledProcessError, IndexError):
            if app.poll() is not None:
                raise RuntimeError('App exited before opening ' + title)
            time.sleep(.25)
    raise RuntimeError('Window missing: ' + title)

def capture(wid, name):
    target = out / (name + '.png')
    run('import', '-window', wid, str(target))
    large = out / 'ocr.png'
    preprocess = ['convert', str(target), '-resize', '200%']
    if name in {'02-picker', '04-folder', '05-selection', '09-cancel-picker'}:
        preprocess += ['-threshold', '80%']
    run(*preprocess, str(large))
    text = run('tesseract', str(large), 'stdout', '--psm', '11', 'tsv')
    rows = list(csv.DictReader(io.StringIO(text), delimiter='\t'))
    for row in rows:
        for dimension in ('left', 'top', 'width', 'height'):
            row[dimension] = str(int(row[dimension]) // 2)
    return target, rows, ' '.join((r.get('text') or '') for r in rows)

def wait_text(wid, name, text):
    deadline = time.monotonic() + 45
    last = ''
    previous = None
    while time.monotonic() < deadline:
        target, rows, last = capture(wid, name)
        signature = [(r.get('text'), r['left'], r['top']) for r in rows]
        if text.lower() in last.lower() and signature == previous:
            print('visible:', name, text, flush=True)
            return rows
        previous = signature
        time.sleep(.25)
    raise RuntimeError('Missing visible text ' + repr(text) + ': ' + last)

def click(wid, x, y):
    run('xdotool', 'mousemove', '--window', wid, str(x), str(y), 'click', '1')

def click_word(wid, rows, word):
    candidates = [r for r in rows if (r.get('text') or '').lower().strip('.,') == word.lower()]
    if not candidates:
        raise RuntimeError('Missing clickable word ' + word)
    r = candidates[-1]
    click(wid, int(r['left']) + int(r['width']) // 2, int(r['top']) + int(r['height']) // 2)

def picker():
    expected = 'xdg-desktop-portal-gtk' if mode == 'portal' else 'zenity'
    deadline = time.monotonic() + 45
    while time.monotonic() < deadline:
        try:
            ids = run('xdotool', 'search', '--onlyvisible', '--name', '.').splitlines()
        except sp.CalledProcessError:
            ids = []
        for wid in ids:
            try:
                pid = run('xdotool', 'getwindowpid', wid)
                exe = os.readlink('/proc/' + pid + '/exe')
            except (sp.CalledProcessError, OSError):
                continue
            if exe.endswith('/' + expected):
                run('xdotool', 'windowsize', wid, '1096', '822')
                run('xdotool', 'windowfocus', '--sync', wid)
                return wid, exe
        time.sleep(.25)
    raise RuntimeError('Native picker missing for backend ' + expected)

log = (out / 'app.log').open('w')
app = sp.Popen([binary], env=env, stdout=log, stderr=sp.STDOUT)
try:
    appwin = window('Lightwell')
    run('xdotool', 'windowsize', appwin, '1280', '850')
    run('xdotool', 'windowfocus', '--sync', appwin)
    rows = wait_text(appwin, '01-empty', 'Open a project folder')
    click(appwin, 540, 485)
    pickwin, exe = picker()
    wait_text(pickwin, '02-picker', 'Cancel')
    key('alt+Home')
    rows = wait_text(pickwin, '04-folder', 'dialog-proof')
    click_word(pickwin, rows, 'dialog-proof')
    _, rows, _ = capture(pickwin, '05-selection')
    key('alt+s' if mode == 'portal' else 'alt+o')
    wait_text(appwin, '06-loaded', 'dialog-proof')
    run('xdotool', 'windowfocus', '--sync', appwin)
    key('ctrl+k')
    run('xdotool', 'type', '--clearmodifiers', '--delay', '45', 'crate root')
    rows = wait_text(appwin, '07-search', 'crate root')
    # The first search result sits directly beneath the header's search field.
    click(appwin, 750, 75)
    wait_text(appwin, '07-selected', 'SOURCE')
    click(appwin, 1100, 542)
    wait_text(appwin, '08-source', 'folder selection worked')
    click(appwin, 540, 27)
    cancelwin, _ = picker()
    wait_text(cancelwin, '09-cancel-picker', 'Home')
    key('Escape')
    wait_text(appwin, '10-after-cancel', 'folder selection worked')
    _, _, visible = capture(appwin, '11-final')
    assert 'dialog-proof' in visible.lower(), visible
    assert 'folder selection worked' in visible.lower(), visible
    result = {'case': mode, 'backend': exe, 'opened_expected_workspace': True,
              'source_marker_visible': True, 'cancel_preserved_workspace_and_source': True}
    (out / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result), flush=True)
finally:
    app.terminate()
    try:
        app.wait(timeout=10)
    except sp.TimeoutExpired:
        app.kill()
        app.wait()
    log.close()
