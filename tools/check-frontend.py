# -*- coding: utf-8 -*-
"""前端自检。本项目没有测试框架，这是唯一的自动化防线。

覆盖四类低级错误：
  1. JS 语法（交给 node --check）
  2. CSS 注释 / 花括号配对、未定义的 CSS 变量
  3. getElementById 引用了 HTML 里不存在的 id
  4. 拆分特有：window.CD 握手不完整、模块顶层读取了别的模块的符号

第 4 项是多文件结构独有的风险：core.js 之外的模块在顶层（加载时）读取
另一个模块回填的符号，会因加载顺序拿到 undefined，且不报错——正是本项目
反复吃亏的那类「静默失效」。模块顶层只允许从 core 取符号。

用法：python tools/check-frontend.py
"""
import io, os, re, subprocess, sys, glob

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)

fail = []


def bad(msg):
    fail.append(msg)
    print('  FAIL  ' + msg)


def ok(msg):
    print('  ok    ' + msg)


html = io.open('src/index.html', encoding='utf-8').read()
cssf = sorted(glob.glob('src/css/*.css'))
jsf = sorted(glob.glob('src/js/*.js'))
JS = {os.path.splitext(os.path.basename(p))[0]: io.open(p, encoding='utf-8').read() for p in jsf}

print('== 1. JS 语法 ==')
for p in jsf:
    r = subprocess.run(['node', '--check', p], capture_output=True, text=True)
    if r.returncode == 0:
        ok(p)
    else:
        bad('%s\n%s' % (p, r.stderr.strip()))

print('== 2. CSS ==')
allcss = ''.join(io.open(p, encoding='utf-8').read() for p in cssf)
stripped = re.sub(r'/\*.*?\*/', '', allcss, flags=re.S)
if allcss.count('/*') == allcss.count('*/'):
    ok('注释配对')
else:
    bad('CSS 注释 /* */ 不配对')
if stripped.count('{') == stripped.count('}'):
    ok('花括号配对')
else:
    bad('CSS 花括号不配对')
undef = sorted(set(re.findall(r'var\((--[a-z0-9-]+)', allcss)) - set(re.findall(r'(--[a-z0-9-]+)\s*:', allcss)))
if undef:
    bad('未定义的 CSS 变量: %s' % ', '.join(undef))
else:
    ok('CSS 变量全部有定义')

print('== 3. id 引用 ==')
missing = sorted(set(re.findall(r'getElementById\("([^"]+)"\)', ''.join(JS.values())))
                 - set(re.findall(r'id="([^"]+)"', html)))
if missing:
    bad('HTML 里没有这些 id: %s' % ', '.join(missing))
else:
    ok('getElementById 全部命中')

print('== 4. window.CD 握手 ==')
# 先写后读，且读取方必须真的被 index.html 加载
loaded = re.findall(r'<script src="\./js/([\w-]+)\.js"></script>', html)
if loaded and loaded[0] != 'core':
    bad('core.js 必须最先加载，当前第一个是 %s.js' % loaded[0])
else:
    ok('core.js 最先加载')
for m in JS:
    if m not in loaded:
        bad('src/js/%s.js 没有被 index.html 加载' % m)

writes, reads = {}, {}
for m, t in JS.items():
    for n in re.findall(r'CD\.([A-Za-z_$][\w$]*)\s*=[^=]', t):
        writes.setdefault(n, set()).add(m)
    for n in re.findall(r'CD\.([A-Za-z_$][\w$]*)', t):
        reads.setdefault(n, set()).add(m)
orphan = sorted(n for n in reads if n not in writes and n != 'xxx')
if orphan:
    bad('只读未写的 CD 符号: %s' % ', '.join(orphan))
else:
    ok('每个 CD 符号都有写入方')

def blank_comments_and_strings(t):
    """把块注释、行注释、字符串替换成等量空格，行号保持不变。

    必须整文件处理而不是逐行：跨行的 /* ... */ 文档注释里提到 CD.xxx 是常事，
    逐行剥离会把它误报成顶层引用——误报多了这个检查就没人看了。"""
    out, i, n = [], 0, len(t)
    while i < n:
        c = t[i]
        if c == '/' and t[i:i + 2] == '/*':
            j = t.find('*/', i + 2)
            j = n if j < 0 else j + 2
        elif c == '/' and t[i:i + 2] == '//':
            j = t.find('\n', i)
            j = n if j < 0 else j
        elif c in '"\'':
            j = i + 1
            while j < n and t[j] != c:
                j += 2 if t[j] == '\\' else 1
            j = min(j + 1, n)
        else:
            out.append(c)
            i += 1
            continue
        out.append(''.join(ch if ch == '\n' else ' ' for ch in t[i:j]))
        i = j
    return ''.join(out)


CORE = set(n for n in writes if 'core' in writes[n])
for m, t in JS.items():
    if m == 'core':
        continue
    depth, hits = 0, []
    for i, l in enumerate(blank_comments_and_strings(t).split('\n'), 1):
        if depth <= 1:
            for n in re.findall(r'CD\.([A-Za-z_$][\w$]*)', l):
                if n not in CORE and not re.match(r'\s*CD\.' + n + r'\s*=', l):
                    hits.append('L%d %s' % (i, n))
        depth += l.count('{') - l.count('}')
    if hits:
        bad('%s.js 顶层读取了非 core 符号（受加载顺序影响）: %s' % (m, ', '.join(hits)))
    else:
        ok('%s.js 顶层只依赖 core' % m)

print()
if fail:
    print('自检未通过，%d 项：' % len(fail))
    for f in fail:
        print('  - ' + f.split('\n')[0])
    sys.exit(1)
print('自检通过')
