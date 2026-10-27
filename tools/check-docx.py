# -*- coding: utf-8 -*-
"""校验 Rust 侧产出的 .docx 样张。

「Word 说文件已损坏」几乎总是出在两处：zip 写坏了，或者某个 part 的 XML 不良构
（标签没闭合、元素顺序错、混进 XML 1.0 非法字符）。Word 只会拒绝打开，不告诉你
错在哪一处，所以必须在这一层先拦住。

用法：
    cd src-tauri && cargo test --lib writes_sample > _t.log 2>&1
    python tools/check-docx.py            # 默认校验 %TEMP%/clay_sample.docx
    python tools/check-docx.py 某文件.docx
"""
import os
import sys
import tempfile
import zipfile
import xml.etree.ElementTree as ET

W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
R = '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}'

path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(tempfile.gettempdir(), 'clay_sample.docx')
if not os.path.exists(path):
    print('找不到 %s\n先跑：cd src-tauri && cargo test --lib writes_sample' % path)
    sys.exit(1)

fail = []


def bad(m):
    fail.append(m)
    print('  FAIL  ' + m)


def ok(m):
    print('  ok    ' + m)


print('校验 %s (%.1f KB)' % (path, os.path.getsize(path) / 1024.0))

print('== 1. zip 结构 ==')
try:
    z = zipfile.ZipFile(path)
except Exception as e:
    print('  FAIL  打不开：%s' % e)
    sys.exit(1)
crc_bad = z.testzip()
if crc_bad:
    bad('CRC 校验失败：%s' % crc_bad)
else:
    ok('CRC 全部正确')

names = z.namelist()
REQUIRED = ['[Content_Types].xml', '_rels/.rels', 'word/document.xml',
            'word/styles.xml', 'word/numbering.xml', 'word/_rels/document.xml.rels']
miss = [n for n in REQUIRED if n not in names]
if miss:
    bad('缺少 part: %s' % ', '.join(miss))
else:
    ok('必需的 part 齐全（共 %d 个条目）' % len(names))

print('== 2. 每个 XML 是否良构 ==')
trees = {}
for n in names:
    if not n.endswith('.xml') and not n.endswith('.rels'):
        continue
    try:
        trees[n] = ET.fromstring(z.read(n))
        ok(n)
    except Exception as e:
        bad('%s 不是良构 XML：%s' % (n, e))

doc = trees.get('word/document.xml')
sty = trees.get('word/styles.xml')

print('== 3. 多级标题 ==')
if sty is not None:
    lv_ok = True
    for lv in range(1, 7):
        st = [s for s in sty.iter(W + 'style') if s.get(W + 'styleId') == 'Heading%d' % lv]
        if not st:
            bad('styles.xml 缺 Heading%d' % lv)
            lv_ok = False
            continue
        nm = st[0].find(W + 'name')
        if nm is None or nm.get(W + 'val') != 'heading %d' % lv:
            bad('Heading%d 的 w:name 不是内建名 "heading %d"' % (lv, lv))
            lv_ok = False
        ol = st[0].find('%spPr/%soutlineLvl' % (W, W))
        if ol is None or ol.get(W + 'val') != str(lv - 1):
            bad('Heading%d 缺 outlineLvl=%d（导航窗格与自动目录会失效）' % (lv, lv - 1))
            lv_ok = False
    if lv_ok:
        ok('Heading1–6 齐全，内建名与 outlineLvl 正确')
    ea = set()
    for rf in sty.iter(W + 'rFonts'):
        if rf.get(W + 'eastAsia'):
            ea.add(rf.get(W + 'eastAsia'))
    if ea:
        ok('中文走 w:eastAsia：%s' % ', '.join(sorted(ea)))
    else:
        bad('没有任何 w:eastAsia，中文会掉回 Word 默认字体')

print('== 4. 正文引用的关系是否都存在 ==')
rels = trees.get('word/_rels/document.xml.rels')
have = set()
targets = {}
if rels is not None:
    for rel in rels:
        have.add(rel.get('Id'))
        targets[rel.get('Id')] = (rel.get('Target'), rel.get('TargetMode'))
used = set()
if doc is not None:
    for el in doc.iter():
        for k, v in el.attrib.items():
            if k in (R + 'embed', R + 'id', R + 'link'):
                used.add(v)
orphan = sorted(used - have)
if orphan:
    bad('正文引用了不存在的关系：%s' % ', '.join(orphan))
else:
    ok('引用的 %d 个 rId 都在 rels 里' % len(used))

# 图片关系必须指向真实存在的 media 文件
for rid in sorted(used):
    tgt, mode = targets.get(rid, (None, None))
    if tgt and not mode and not tgt.endswith('.xml'):
        if 'word/' + tgt not in names:
            bad('rId%s 指向 word/%s，但包里没有这个文件' % (rid, tgt))

print('== 5. 图片 ==')
if doc is not None:
    ids = [e.get('id') for e in doc.iter() if e.tag.endswith('}docPr')]
    if not ids:
        ok('文档里没有图片')
    else:
        if len(ids) != len(set(ids)):
            bad('wp:docPr id 有重复：%s' % ids)
        elif '0' in ids:
            bad('wp:docPr id 不能为 0')
        else:
            ok('docPr id 唯一且非 0：%s' % ', '.join(ids))
        # wp:extent 与 a:ext 必须一一对应
        ext = [(e.get('cx'), e.get('cy')) for e in doc.iter()
               if e.tag.endswith('}extent') or e.tag.endswith('}ext')]
        pairs = {}
        for cx, cy in ext:
            pairs[(cx, cy)] = pairs.get((cx, cy), 0) + 1
        oddball = [k for k, v in pairs.items() if v % 2]
        if oddball:
            bad('wp:extent 与 a:ext 尺寸对不上：%s' % oddball)
        else:
            ok('extent / a:ext 尺寸一致')

print('== 6. 表格 ==')
if doc is not None:
    for ti, tbl in enumerate(doc.iter(W + 'tbl'), 1):
        # 代码块也是用表格做的（靠单元格的 tcMar 拿内边距），它不是数据表格，
        # 不该按数据表格的规矩查边框。数据表格都带 TableGrid 样式，以此区分。
        st = tbl.find('%stblPr/%stblStyle' % (W, W))
        is_data = st is not None and st.get(W + 'val') == 'TableGrid'
        if not is_data:
            cm = tbl.find('%stblPr/%stblCellMar' % (W, W))
            if cm is None:
                bad('第 %d 个表格既不是数据表格也没有 tblCellMar' % ti)
            else:
                ok('第 %d 个表格：代码块容器，有内边距' % ti)
            continue
        grid = tbl.find(W + 'tblGrid')
        if grid is None:
            bad('第 %d 个表格缺 w:tblGrid，Word 会把列宽算乱' % ti)
            continue
        cols = len(grid.findall(W + 'gridCol'))
        widths = set(len(tr.findall(W + 'tc')) for tr in tbl.findall(W + 'tr'))
        if widths - {cols}:
            bad('第 %d 个表格各行单元格数 %s 与 gridCol 数 %d 不一致' % (ti, sorted(widths), cols))
        else:
            ok('第 %d 个表格：%d 列，各行一致，有 tblGrid' % (ti, cols))
        # 六边全框。少一边 Word 不会报错，只是表格看着缺一道线，靠肉眼容易漏
        bd = tbl.find('%stblPr/%stblBorders' % (W, W))
        sides = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
        if bd is None:
            bad('第 %d 个表格没有 tblBorders' % ti)
        else:
            weak = [s for s in sides
                    if bd.find(W + s) is None
                    or bd.find(W + s).get(W + 'val') in (None, 'none', 'nil')]
            if weak:
                bad('第 %d 个表格缺边框：%s' % (ti, ', '.join(weak)))
            else:
                ok('第 %d 个表格：六边边框齐全' % ti)

print('== 7. 列表编号 ==')
num = trees.get('word/numbering.xml')
if num is not None and doc is not None:
    defined = set(n.get(W + 'val') for n in num.iter(W + 'abstractNumId'))
    numid_map = {}
    for n in num.iter(W + 'num'):
        a = n.find(W + 'abstractNumId')
        numid_map[n.get(W + 'numId')] = a.get(W + 'val') if a is not None else None
    usedn = set(e.get(W + 'val') for e in doc.iter(W + 'numId'))
    missing = [u for u in usedn if u not in numid_map]
    if missing:
        bad('正文用了未定义的 numId：%s' % ', '.join(sorted(missing)))
    elif any(numid_map[u] not in defined for u in usedn):
        bad('numId 指向了不存在的 abstractNumId')
    else:
        ok('用到的 numId %s 都指向有效的 abstractNum' % sorted(usedn))

print('== 8. 元素顺序（「文件已损坏」的头号来源）==')
# OOXML 的 CT_RPr / CT_PPr 是 xsd:sequence，子元素次序由 schema 强制。
# 顺序错了 XML 依然良构，前面几项全会通过，但 Word 会拒绝打开且不说原因——
# 所以这一项必须单独查。下面是 schema 里的次序，只列本项目会写出的那些。
RPR_ORDER = ['rStyle', 'rFonts', 'b', 'bCs', 'i', 'iCs', 'caps', 'smallCaps',
             'strike', 'dstrike', 'outline', 'shadow', 'emboss', 'imprint',
             'noProof', 'snapToGrid', 'vanish', 'webHidden', 'color', 'spacing',
             'w', 'kern', 'position', 'sz', 'szCs', 'highlight', 'u', 'effect',
             'bdr', 'shd', 'fitText', 'vertAlign', 'rtl', 'cs', 'em', 'lang']
PPR_ORDER = ['pStyle', 'keepNext', 'keepLines', 'pageBreakBefore', 'framePr',
             'widowControl', 'numPr', 'suppressLineNumbers', 'pBdr', 'shd', 'tabs',
             'suppressAutoHyphens', 'kinsoku', 'wordWrap', 'overflowPunct',
             'topLinePunct', 'autoSpaceDE', 'autoSpaceDN', 'bidi', 'adjustRightInd',
             'snapToGrid', 'spacing', 'ind', 'contextualSpacing', 'mirrorIndents',
             'suppressOverlap', 'jc', 'textDirection', 'textAlignment',
             'textboxTightWrap', 'outlineLvl', 'divId', 'cnfStyle', 'rPr', 'sectPr']


def check_order(root, tag, order, label):
    bad_n = 0
    for node in root.iter(W + tag):
        seen, prev, prev_name = [], -1, ''
        for ch in node:
            nm = ch.tag[len(W):] if ch.tag.startswith(W) else ch.tag
            if nm not in order:
                continue
            k = order.index(nm)
            if k < prev:
                bad_n += 1
                bad('%s 里 <w:%s> 排在 <w:%s> 之后，schema 要求相反（%s）'
                    % (label, nm, prev_name, ' → '.join(seen[-3:] + [nm])))
                break
            prev, prev_name = k, nm
            seen.append(nm)
    return bad_n


order_bad = 0
for part, root in (('document.xml', doc), ('styles.xml', sty)):
    if root is None:
        continue
    order_bad += check_order(root, 'rPr', RPR_ORDER, part + ' 的 w:rPr')
    order_bad += check_order(root, 'pPr', PPR_ORDER, part + ' 的 w:pPr')
if not order_bad:
    ok('w:rPr / w:pPr 的子元素次序都符合 schema')

# w:pPr 必须是 w:p 的第一个子元素
if doc is not None:
    late = 0
    for p in doc.iter(W + 'p'):
        kids = list(p)
        for i, ch in enumerate(kids):
            if ch.tag == W + 'pPr' and i != 0:
                late += 1
    if late:
        bad('有 %d 个 <w:p> 的 <w:pPr> 不在首位（必须排在所有 run 之前）' % late)
    else:
        ok('每个 <w:p> 的 <w:pPr> 都在首位')

print()
if fail:
    print('校验未通过，%d 项' % len(fail))
    sys.exit(1)
print('校验通过 —— zip 与 XML 层面没问题')
print('（仍需用 Word 实际打开一次：字体、分页、观感这些只有 Word 说了算）')
