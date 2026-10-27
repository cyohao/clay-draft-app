//! 导出 .docx。
//!
//! 分工：**markdown 的解析在前端**（`src/js/word.js` 用已经在跑的 marked），
//! 这里只负责「中间结构 IR → OOXML → zip」。不在 Rust 里再写一套 markdown 解析器——
//! 那必然与预览分叉，GFM 表格、任务列表这些行为对不上就会出现「预览一个样、导出另一个样」。
//!
//! 版面参数**以** `src/css/media.css` 的 `@media print` **为基准**（见 `layout`），
//! 但有几处按使用者反馈刻意偏离：正文与标题行距一律单倍（print 是 1.7）、
//! 标题段前段后收窄、表格六边全框、代码块靠单元格拿内边距。这些都在 `layout` 里注明了，
//! **不要为了「和 print 对齐」改回去**，`cargo test` 里有对应的测试挡着。
//!
//! ## 写这个文件时最容易翻车的地方
//!
//! **OOXML 的子元素顺序是 schema 强制的。** `w:pPr` 必须排在该段所有 run 之前；
//! `w:rPr` 内部是 `rStyle → rFonts → b → i → strike → color → sz → szCs → u → shd`；
//! `w:pPr` 内部是 `pStyle → numPr → pBdr → shd → spacing → ind → jc → outlineLvl`。
//! 顺序错了 Word 报「文件已损坏」并拒绝打开，**不会**降级忽略，也不会指出错在哪一处。
//! 本文件里凡是拼 `rPr` / `pPr` 的地方都按上面的次序排，改动时别图省事插在中间。

use serde::Deserialize;

// ===================== IR =====================
// 字段名一律用单个词，避免 serde 的 camelCase 改名规则掺进来。

#[derive(Deserialize, Default, Clone)]
pub struct Run {
    #[serde(default)]
    pub text: String,
    /// 加粗
    #[serde(default)]
    pub b: bool,
    /// 斜体
    #[serde(default)]
    pub i: bool,
    /// 删除线
    #[serde(default)]
    pub s: bool,
    /// 行内代码：等宽 + 浅底
    #[serde(default)]
    pub code: bool,
    /// 非空则是超链接目标
    #[serde(default)]
    pub link: String,
    /// 非空则是 RRGGBB（语法高亮用）
    #[serde(default)]
    pub color: String,
    /// 软换行。marked 开了 breaks:true，单个换行也要换行，不能当空格吞掉
    #[serde(default)]
    pub br: bool,
}

#[derive(Deserialize)]
pub struct Item {
    /// 嵌套深度，0 起。前端已把嵌套列表拍平，这里不再递归
    #[serde(default)]
    pub level: u8,
    /// 有序项的字面序号，形如 "1."；空串表示无序项。
    /// 由前端按「每个列表各自从 start 起算」算好，**不走 Word 的自动编号**，理由见渲染处。
    #[serde(default)]
    pub num: String,
    #[serde(default)]
    pub runs: Vec<Run>,
}

#[derive(Deserialize)]
#[serde(tag = "type")]
pub enum Block {
    #[serde(rename = "heading")]
    Heading { level: u8, runs: Vec<Run> },
    #[serde(rename = "para")]
    Para { runs: Vec<Run> },
    #[serde(rename = "code")]
    Code {
        /// 语言名。当前不参与排版（着色已在前端做完），保留是为了
        /// 协议自描述，将来要按语言做区分时不用改前端。
        #[allow(dead_code)]
        #[serde(default)]
        lang: String,
        lines: Vec<Vec<Run>>,
    },
    #[serde(rename = "quote")]
    Quote { blocks: Vec<Block> },
    #[serde(rename = "list")]
    List { items: Vec<Item> },
    #[serde(rename = "table")]
    Table {
        header: Vec<Vec<Run>>,
        rows: Vec<Vec<Vec<Run>>>,
        #[serde(default)]
        align: Vec<String>,
    },
    #[serde(rename = "hr")]
    Hr,
    #[serde(rename = "image")]
    Image {
        id: String,
        #[serde(default)]
        w: u32,
        #[serde(default)]
        h: u32,
        #[serde(default)]
        alt: String,
    },
}

#[derive(Deserialize)]
pub struct ImageData {
    pub id: String,
    /// base64，不带 data: 前缀
    pub data: String,
    /// png / jpeg / gif / bmp
    pub ext: String,
}

#[derive(Deserialize)]
pub struct DocIr {
    pub blocks: Vec<Block>,
    #[serde(default)]
    pub images: Vec<ImageData>,
    #[serde(default)]
    pub title: String,
}

// ===================== 版面常量 =====================

/// 以 `src/css/media.css` 的 `@media print` 为基准；刻意偏离的几项在各自处注明。
mod layout {
    /// A4 210mm × 297mm，单位 twip（1/1440 英寸）
    pub const PAGE_W: u32 = 11906;
    pub const PAGE_H: u32 = 16838;
    /// @page margin: 20mm 18mm
    pub const MAR_V: u32 = 1134;
    pub const MAR_H: u32 = 1021;
    /// 版心宽度，表格与图片按它约束
    pub const CONTENT_W: u32 = PAGE_W - MAR_H * 2;

    /// w:sz 的单位是半磅。正文 11pt，标题 20/15/12.5/11pt，代码 9.5pt
    pub const SZ_BODY: u32 = 22;
    pub const SZ_H: [u32; 6] = [40, 30, 25, 22, 22, 22];
    pub const SZ_CODE: u32 = 19;

    /// 正文行距，单倍。w:line 在 lineRule=auto 下以 240 为单倍行距。
    ///
    /// **有意不跟 `@media print`**：打印样式是 1.7，那个值在屏幕和 PDF 上好看，
    /// 落到 Word 的纸面上偏松。1.7 → 1.5 → 单倍，是按使用者反馈一路收下来的，
    /// 不是漏改，别「顺手改回去和 print 对齐」。段落之间的呼吸由段后距给，不靠行距。
    pub const LINE: u32 = 240;

    /// 标题各级的行距，一律单倍（240）。
    ///
    /// **标题不能套正文的行距。** 超出字号的那部分行距，Word 大半摊在文字下方——
    /// 看起来就是「标题下面空一大块」，字号越大越明显。这里曾经全填 408（1.7 倍），
    /// 正是那个毛病的来源；后来按 CSS 给到 1.3/1.35 仍偏松，最终定为单倍。
    /// 标题基本都是一两行，单倍不会挤，也不需要靠行距去拉层次——层次由字号和段前距给。
    pub const LINE_H: [u32; 6] = [240, 240, 240, 240, 240, 240];

    /// 西文一律 Times New Roman；中文按角色分派，与 --sans / --serif / --mono 对应。
    /// 代码的中文用新宋体：Consolas 不含汉字，而新宋体是等宽的，
    /// 用微软雅黑会让含中文注释的代码列错开。
    pub const F_ASCII: &str = "Times New Roman";
    pub const F_CJK: &str = "Microsoft YaHei";
    pub const F_CJK_SERIF: &str = "Noto Serif SC";
    pub const F_MONO: &str = "Consolas";
    pub const F_MONO_CJK: &str = "NSimSun";

    /// 正文段落的段前 / 段后，各 5 磅（1pt = 20twip）。
    /// Word 是把上一段的段后与下一段的段前**相加**的（不像 CSS 的 margin 会折叠），
    /// 所以相邻两段之间实际是 10 磅。段落之间的呼吸全靠这个，行距是单倍不参与。
    pub const PARA_BEFORE: u32 = 100;
    pub const PARA_AFTER: u32 = 100;

    /// 代码块的内边距（twip）。段落底纹给不出内边距——底纹的边界就是文字的边界，
    /// 所以代码块套在单元格里，靠 w:tcMar 实现。
    pub const CODE_PAD_H: u32 = 170;
    pub const CODE_PAD_V: u32 = 120;

    /// 取自 @media print 的调色板
    pub const C_INK: &str = "141413";
    pub const C_INK_SOFT: &str = "4A4843";
    pub const C_CLAY: &str = "C2643F";
    pub const C_LINE: &str = "D9D5CA";
    pub const C_CODE_BG: &str = "E5E0D2";
}

use layout as L;

// ===================== 最小 ZIP writer =====================

/// 只写不读，够用就好。用 flate2 / crc32fast —— 这两个 crate 已经在
/// Cargo.lock 里（tauri 传递引入），提为直接依赖不会触发新的下载。
mod zipw {
    use std::io::Write;

    struct Entry {
        name: String,
        crc: u32,
        comp: u32,
        raw: u32,
        offset: u32,
    }

    pub struct Zip {
        buf: Vec<u8>,
        entries: Vec<Entry>,
    }

    fn u16le(b: &mut Vec<u8>, v: u16) {
        b.extend_from_slice(&v.to_le_bytes());
    }
    fn u32le(b: &mut Vec<u8>, v: u32) {
        b.extend_from_slice(&v.to_le_bytes());
    }

    impl Zip {
        pub fn new() -> Self {
            Zip { buf: Vec::new(), entries: Vec::new() }
        }

        pub fn add(&mut self, name: &str, data: &[u8]) -> Result<(), String> {
            let crc = crc32fast::hash(data);
            let mut enc = flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::default());
            enc.write_all(data).map_err(|e| format!("压缩失败：{e}"))?;
            let comp = enc.finish().map_err(|e| format!("压缩失败：{e}"))?;

            let offset = self.buf.len() as u32;
            let nb = name.as_bytes();
            u32le(&mut self.buf, 0x0403_4b50); // local file header
            u16le(&mut self.buf, 20); // version needed
            u16le(&mut self.buf, 0x0800); // 文件名按 UTF-8 解释
            u16le(&mut self.buf, 8); // deflate
            u16le(&mut self.buf, 0); // mod time
            u16le(&mut self.buf, 0x0021); // mod date = 1980-01-01
            u32le(&mut self.buf, crc);
            u32le(&mut self.buf, comp.len() as u32);
            u32le(&mut self.buf, data.len() as u32);
            u16le(&mut self.buf, nb.len() as u16);
            u16le(&mut self.buf, 0); // extra
            self.buf.extend_from_slice(nb);
            self.buf.extend_from_slice(&comp);

            self.entries.push(Entry {
                name: name.to_string(),
                crc,
                comp: comp.len() as u32,
                raw: data.len() as u32,
                offset,
            });
            Ok(())
        }

        pub fn finish(mut self) -> Vec<u8> {
            let cd_off = self.buf.len() as u32;
            for e in &self.entries {
                let nb = e.name.as_bytes();
                u32le(&mut self.buf, 0x0201_4b50); // central directory header
                u16le(&mut self.buf, 20); // version made by
                u16le(&mut self.buf, 20); // version needed
                u16le(&mut self.buf, 0x0800);
                u16le(&mut self.buf, 8);
                u16le(&mut self.buf, 0);
                u16le(&mut self.buf, 0x0021);
                u32le(&mut self.buf, e.crc);
                u32le(&mut self.buf, e.comp);
                u32le(&mut self.buf, e.raw);
                u16le(&mut self.buf, nb.len() as u16);
                u16le(&mut self.buf, 0); // extra
                u16le(&mut self.buf, 0); // comment
                u16le(&mut self.buf, 0); // disk
                u16le(&mut self.buf, 0); // internal attrs
                u32le(&mut self.buf, 0); // external attrs
                u32le(&mut self.buf, e.offset);
                self.buf.extend_from_slice(nb);
            }
            let cd_size = self.buf.len() as u32 - cd_off;
            let n = self.entries.len() as u16;
            u32le(&mut self.buf, 0x0605_4b50); // EOCD
            u16le(&mut self.buf, 0);
            u16le(&mut self.buf, 0);
            u16le(&mut self.buf, n);
            u16le(&mut self.buf, n);
            u32le(&mut self.buf, cd_size);
            u32le(&mut self.buf, cd_off);
            u16le(&mut self.buf, 0);
            self.buf
        }
    }
}

// ===================== XML 工具 =====================

/// 转义并**丢掉 XML 1.0 非法字符**。md 里混进 U+0000–U+0008 这类控制字符时，
/// 光转义是不够的——它们在 XML 1.0 里根本不合法，留着会让 Word 直接拒绝打开。
fn esc(s: &str) -> String {
    let mut o = String::with_capacity(s.len() + 8);
    for c in s.chars() {
        match c {
            '&' => o.push_str("&amp;"),
            '<' => o.push_str("&lt;"),
            '>' => o.push_str("&gt;"),
            '"' => o.push_str("&quot;"),
            '\t' | '\n' | '\r' => o.push(c),
            c if (c as u32) < 0x20 => {}
            '\u{FFFE}' | '\u{FFFF}' => {}
            c => o.push(c),
        }
    }
    o
}

/// px → EMU。96dpi 下 1px = 9525 EMU。
fn emu(px: u32) -> u64 {
    px as u64 * 9525
}

const HEX: &[u8] = b"ABCDEF0123456789";

fn is_hex6(s: &str) -> bool {
    s.len() == 6 && s.bytes().all(|b| HEX.contains(&b.to_ascii_uppercase()))
}

// ===================== 正文生成 =====================

struct Builder {
    body: String,
    /// 外链按出现顺序登记，最后写进 document.xml.rels
    links: Vec<String>,
    /// 图片 id 表，顺序与 word/media/ 里的编号一致。
    /// 按 id 查下标而不是从 "img3" 里解析数字——后者要求前端的数组顺序
    /// 恰好与 id 编号一致，是个没人会记得的隐式约定，错了就是配错图。
    img_ids: Vec<String>,
    /// wp:docPr 的 id 必须全局唯一且非 0，重复会让 Word 报错
    draw_id: u32,
    rid_img_base: usize,
    /// 当前是否在引用块内，决定段落要不要套 Quote 样式
    in_quote: bool,
}

impl Builder {
    /// `w:rPr`。元素次序见文件头的说明，不要重排。
    fn rpr(&self, r: &Run, ctx_sz: u32, mono_ctx: bool) -> String {
        let mut s = String::from("<w:rPr>");
        if !r.link.is_empty() {
            s.push_str(r#"<w:rStyle w:val="Hyperlink"/>"#);
        }
        let mono = r.code || mono_ctx;
        if mono {
            s.push_str(&format!(
                r#"<w:rFonts w:ascii="{m}" w:hAnsi="{m}" w:eastAsia="{c}" w:cs="{m}"/>"#,
                m = L::F_MONO,
                c = L::F_MONO_CJK
            ));
        }
        if r.b {
            s.push_str("<w:b/><w:bCs/>");
        }
        if r.i {
            s.push_str("<w:i/><w:iCs/>");
        }
        if r.s {
            s.push_str("<w:strike/>");
        }
        if is_hex6(&r.color) {
            s.push_str(&format!(r#"<w:color w:val="{}"/>"#, r.color.to_uppercase()));
        } else if r.code && r.link.is_empty() {
            s.push_str(&format!(r#"<w:color w:val="{}"/>"#, L::C_CLAY));
        }
        let sz = if mono { L::SZ_CODE } else { ctx_sz };
        s.push_str(&format!(r#"<w:sz w:val="{sz}"/><w:szCs w:val="{sz}"/>"#));
        // 行内代码给个浅底。w:shd 在 schema 里排在 u 之后，别往前挪。
        if r.code && !mono_ctx {
            s.push_str(&format!(
                r#"<w:shd w:val="clear" w:color="auto" w:fill="{}"/>"#,
                L::C_CODE_BG
            ));
        }
        s.push_str("</w:rPr>");
        s
    }

    fn runs(&mut self, rs: &[Run], sz: u32, mono_ctx: bool) -> String {
        let mut out = String::new();
        for r in rs {
            if r.br {
                out.push_str(&format!("<w:r>{}<w:br/></w:r>", self.rpr(r, sz, mono_ctx)));
                continue;
            }
            if r.text.is_empty() {
                continue;
            }
            // xml:space="preserve" 必须有，否则首尾空格会被吃掉，
            // 代码块的缩进会整体塌掉。
            let core = format!(
                r#"<w:r>{}<w:t xml:space="preserve">{}</w:t></w:r>"#,
                self.rpr(r, sz, mono_ctx),
                esc(&r.text)
            );
            if r.link.is_empty() {
                out.push_str(&core);
            } else {
                // 超链接是「关系」不是属性：要在 rels 里登记一条 External
                self.links.push(r.link.clone());
                let rid = self.rid_img_base + self.img_ids.len() + self.links.len();
                out.push_str(&format!(
                    r#"<w:hyperlink r:id="rId{rid}">{core}</w:hyperlink>"#
                ));
            }
        }
        out
    }

    fn block(&mut self, b: &Block) {
        match b {
            Block::Heading { level, runs } => {
                let lv = (*level).clamp(1, 6) as usize;
                let inner = self.runs(runs, L::SZ_H[lv - 1], false);
                self.body.push_str(&format!(
                    r#"<w:p><w:pPr><w:pStyle w:val="Heading{lv}"/></w:pPr>{inner}</w:p>"#
                ));
            }
            Block::Para { runs } => {
                let inner = self.runs(runs, L::SZ_BODY, false);
                let ppr = if self.in_quote {
                    r#"<w:pPr><w:pStyle w:val="Quote"/></w:pPr>"#
                } else {
                    ""
                };
                self.body.push_str(&format!("<w:p>{ppr}{inner}</w:p>"));
            }
            Block::Hr => {
                // 分割线用段落的下边框来做，Word 里没有独立的「水平线」段落元素
                self.body.push_str(&format!(
                    r#"<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="{}"/></w:pBdr><w:spacing w:before="240" w:after="240"/></w:pPr></w:p>"#,
                    L::C_LINE
                ));
            }
            Block::Code { lang: _, lines } => {
                // 代码块套在一个单元格的表格里，为的是拿到**内边距**。
                //
                // 段落底纹（w:shd）铺满的范围就是左右缩进之间那条带子，文字正好贴着
                // 底纹边缘，压根没有内边距这一说；缩进只会把底纹连同文字一起挪走。
                // 单元格的 w:tcMar 才是真正的四边内边距，底色由单元格出。
                //
                // 行仍然一行一段：整块塞进一个段落的话长代码没法分页。表格行默认
                // 允许跨页断开（没写 cantSplit），所以长代码块照样能翻页。
                let w = L::CONTENT_W;
                self.body.push_str(&format!(
                    r#"<w:tbl><w:tblPr><w:tblW w:w="{w}" w:type="dxa"/><w:tblLayout w:type="fixed"/><w:tblCellMar><w:top w:w="{pv}" w:type="dxa"/><w:left w:w="{ph}" w:type="dxa"/><w:bottom w:w="{pv}" w:type="dxa"/><w:right w:w="{ph}" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid><w:gridCol w:w="{w}"/></w:tblGrid><w:tr><w:tc><w:tcPr><w:tcW w:w="{w}" w:type="dxa"/><w:shd w:val="clear" w:color="auto" w:fill="{bg}"/></w:tcPr>"#,
                    pv = L::CODE_PAD_V,
                    ph = L::CODE_PAD_H,
                    bg = L::C_CODE_BG
                ));
                for line in lines {
                    let inner = self.runs(line, L::SZ_CODE, true);
                    self.body.push_str(&format!(
                        r#"<w:p><w:pPr><w:pStyle w:val="CodeBlock"/></w:pPr>{inner}</w:p>"#
                    ));
                }
                self.body.push_str("</w:tc></w:tr></w:tbl>");
                // 表格后必须跟一个段落，否则紧挨着的下一个表格会被 Word 并进来
                self.body.push_str(r#"<w:p><w:pPr><w:spacing w:after="0"/></w:pPr></w:p>"#);
            }
            Block::Quote { blocks } => {
                // 引用在 OOXML 里没有独立容器，只能给内部每段套 Quote 样式。
                // 用状态位往下传，不要事后对拼好的 XML 做字符串替换——
                // 那会连表格单元格里的段落一起改掉。
                let prev = self.in_quote;
                self.in_quote = true;
                for b in blocks {
                    self.block(b);
                }
                self.in_quote = prev;
            }
            Block::List { items } => {
                for it in items {
                    let ilvl = it.level.min(8) as u32;
                    let inner = self.runs(&it.runs, L::SZ_BODY, false);
                    if it.num.is_empty() {
                        // 无序：交给 numbering.xml 的项目符号。项目符号没有「全文递增」
                        // 这回事，用 Word 的列表反而能拿到正经的悬挂缩进。
                        self.body.push_str(&format!(
                            r#"<w:p><w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="{ilvl}"/><w:numId w:val="1"/></w:numPr></w:pPr>{inner}</w:p>"#
                        ));
                    } else {
                        // 有序：序号当正文写死，**不用 Word 的自动编号**。
                        // 自动编号会把全文所有有序列表当成同一个序列一路递增下去——
                        // 第二个列表接着上一个的号继续数。而 markdown 里每个列表都是
                        // 独立的，各自从自己的 start 开始。
                        //
                        // 序号后跟一个 tab，配合悬挂缩进，折行的第二行才会与首行文字
                        // 对齐，而不是顶到序号底下。
                        let left = 420 * (ilvl + 1);
                        let marker = Run { text: it.num.clone(), ..Default::default() };
                        let mpr = self.rpr(&marker, L::SZ_BODY, false);
                        self.body.push_str(&format!(
                            r#"<w:p><w:pPr><w:pStyle w:val="ListParagraph"/><w:ind w:left="{left}" w:hanging="420"/></w:pPr><w:r>{mpr}<w:t xml:space="preserve">{num}</w:t></w:r><w:r>{mpr}<w:tab/></w:r>{inner}</w:p>"#,
                            num = esc(&it.num)
                        ));
                    }
                }
            }
            Block::Table { header, rows, align } => self.table(header, rows, align),
            Block::Image { id, w, h, alt } => self.image(id, *w, *h, alt),
        }
    }

    fn table(&mut self, header: &[Vec<Run>], rows: &[Vec<Vec<Run>>], align: &[String]) {
        let cols = header.len().max(rows.iter().map(|r| r.len()).max().unwrap_or(0)).max(1);
        let cw = L::CONTENT_W / cols as u32;

        let mut t = String::from(r#"<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/>"#);
        t.push_str(&format!(
            r#"<w:tblW w:w="{}" w:type="dxa"/>"#,
            L::CONTENT_W
        ));
        // 六边全给实线：预览里表格是「只有横线」的排版风格，但导出到 Word 的
        // 多半要进正式文档，那边通行的是完整网格。这是有意与预览不同的一处。
        t.push_str(&format!(
            r#"<w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="{c}"/><w:left w:val="single" w:sz="4" w:space="0" w:color="{c}"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="{c}"/><w:right w:val="single" w:sz="4" w:space="0" w:color="{c}"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="{c}"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="{c}"/></w:tblBorders>"#,
            c = L::C_LINE
        ));
        t.push_str(r#"<w:tblLayout w:type="fixed"/><w:tblCellMar><w:top w:w="60" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="60" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr>"#);
        // tblGrid 缺了 Word 会把列宽算乱
        t.push_str("<w:tblGrid>");
        for _ in 0..cols {
            t.push_str(&format!(r#"<w:gridCol w:w="{cw}"/>"#));
        }
        t.push_str("</w:tblGrid>");
        self.body.push_str(&t);

        if !header.is_empty() {
            // tblHeader = 跨页时重复表头；cantSplit = 单行不被腰斩
            self.row(header, cols, cw, align, true);
        }
        for r in rows {
            self.row(r, cols, cw, align, false);
        }
        self.body.push_str("</w:tbl>");
        // 表格后面必须跟一个段落，否则两个连续表格会被 Word 合并
        self.body.push_str(r#"<w:p><w:pPr><w:spacing w:after="0"/></w:pPr></w:p>"#);
    }

    fn row(&mut self, cells: &[Vec<Run>], cols: usize, cw: u32, align: &[String], head: bool) {
        let mut s = String::from("<w:tr><w:trPr><w:cantSplit/>");
        if head {
            s.push_str("<w:tblHeader/>");
        }
        s.push_str("</w:trPr>");
        self.body.push_str(&s);

        for ci in 0..cols {
            let empty: Vec<Run> = Vec::new();
            let cell = cells.get(ci).unwrap_or(&empty);
            let jc = match align.get(ci).map(|s| s.as_str()) {
                Some("center") => r#"<w:jc w:val="center"/>"#,
                Some("right") => r#"<w:jc w:val="right"/>"#,
                _ => "",
            };
            let mut runs = cell.clone();
            if head {
                for r in runs.iter_mut() {
                    r.b = true;
                }
            }
            let inner = self.runs(&runs, L::SZ_BODY, false);
            let shd = if head {
                format!(r#"<w:shd w:val="clear" w:color="auto" w:fill="{}"/>"#, "F4F2EC")
            } else {
                String::new()
            };
            self.body.push_str(&format!(
                r#"<w:tc><w:tcPr><w:tcW w:w="{cw}" w:type="dxa"/>{shd}<w:vAlign w:val="top"/></w:tcPr><w:p><w:pPr><w:spacing w:before="20" w:after="20" w:line="276" w:lineRule="auto"/>{jc}</w:pPr>{inner}</w:p></w:tc>"#
            ));
        }
        self.body.push_str("</w:tr>");
    }

    fn image(&mut self, id: &str, w: u32, h: u32, alt: &str) {
        let idx = match self.img_ids.iter().position(|x| x == id) {
            Some(i) => i + 1,
            None => return, // 引用了不存在的图，整段跳过而不是写出坏的 rId
        };
        let rid = self.rid_img_base + idx;
        let (w, h) = (w.max(1), h.max(1));
        let (cx, cy) = (emu(w), emu(h));
        self.draw_id += 1;
        let did = self.draw_id;
        let name = esc(if alt.is_empty() { "图片" } else { alt });
        self.body.push_str(&format!(
            r#"<w:p><w:pPr><w:spacing w:before="160" w:after="160"/><w:jc w:val="center"/></w:pPr><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="{cx}" cy="{cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="{did}" name="Picture {did}" descr="{name}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="{did}" name="Picture {did}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rId{rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="{cx}" cy="{cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>"#
        ));
    }
}

// ===================== 各 part =====================

fn content_types(exts: &[String]) -> String {
    let mut s = String::from(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>"#,
    );
    for e in exts {
        let mime = match e.as_str() {
            "png" => "image/png",
            "jpeg" | "jpg" => "image/jpeg",
            "gif" => "image/gif",
            "bmp" => "image/bmp",
            _ => continue,
        };
        s.push_str(&format!(r#"<Default Extension="{e}" ContentType="{mime}"/>"#));
    }
    s.push_str(r#"<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>"#);
    s
}

fn root_rels() -> String {
    r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>"#.to_string()
}

fn doc_rels(images: &[ImageData], links: &[String], base: usize) -> String {
    let mut s = String::from(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>"#,
    );
    for (i, im) in images.iter().enumerate() {
        s.push_str(&format!(
            r#"<Relationship Id="rId{}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/img{}.{}"/>"#,
            base + i + 1,
            i + 1,
            im.ext
        ));
    }
    for (i, l) in links.iter().enumerate() {
        s.push_str(&format!(
            r#"<Relationship Id="rId{}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="{}" TargetMode="External"/>"#,
            base + images.len() + i + 1,
            esc(l)
        ));
    }
    s.push_str("</Relationships>");
    s
}

fn core_props(title: &str) -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>{}</dc:title><dc:creator>Clay Draft</dc:creator><cp:lastModifiedBy>Clay Draft</cp:lastModifiedBy></cp:coreProperties>"#,
        esc(title)
    )
}

fn fonts_tag(ascii: &str, cjk: &str) -> String {
    format!(
        r#"<w:rFonts w:ascii="{ascii}" w:hAnsi="{ascii}" w:eastAsia="{cjk}" w:cs="{ascii}"/>"#
    )
}

fn styles() -> String {
    let mut s = String::from(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">"#,
    );
    s.push_str(&format!(
        r#"<w:docDefaults><w:rPrDefault><w:rPr>{f}<w:color w:val="{ink}"/><w:sz w:val="{sz}"/><w:szCs w:val="{sz}"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:before="{before}" w:after="{after}" w:line="{line}" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>"#,
        f = fonts_tag(L::F_ASCII, L::F_CJK),
        ink = L::C_INK,
        sz = L::SZ_BODY,
        before = L::PARA_BEFORE,
        after = L::PARA_AFTER,
        line = L::LINE
    ));

    s.push_str(&format!(
        r#"<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:before="{before}" w:after="{after}" w:line="{line}" w:lineRule="auto"/></w:pPr><w:rPr>{f}<w:sz w:val="{sz}"/></w:rPr></w:style>"#,
        f = fonts_tag(L::F_ASCII, L::F_CJK),
        sz = L::SZ_BODY,
        before = L::PARA_BEFORE,
        after = L::PARA_AFTER,
        line = L::LINE
    ));

    // 标题：w:name 必须写成内建名 "heading N"，Word 中文界面才显示成「标题 N」；
    // w:outlineLvl 是导航窗格、折叠和自动目录的依据，缺了这三样都不工作。
    // (段前, 段后)，单位 twip。
    //
    // 段后一律 100（5pt），各级统一，比 CSS 的 margin-bottom 紧不少：预览里标题下方
    // 还有一条细边框和 .35em 内距把空白「撑出结构」，Word 这边没有那条线，
    // 同样的数值读起来就是一片空荡。各级之间的观感差异交给行距去拉开，
    // 不靠段后距——字号越大行距的绝对值越大，段后距再按比例放大就过头了。
    // 段前按级别递减拉层次；CSS 那边 h2 是 2em（=600twip），在 Word 里太空，取约四成。
    let spacing = [
        (0, 100),
        (240, 100),
        (200, 100),
        (180, 100),
        (160, 100),
        (160, 100),
    ];
    for lv in 1..=6usize {
        let cjk = if lv <= 2 { L::F_CJK_SERIF } else { L::F_CJK };
        let (before, after) = spacing[lv - 1];
        let bold = if lv >= 3 { "<w:b/><w:bCs/>" } else { "" };
        let color = if lv <= 2 { L::C_INK } else { L::C_INK_SOFT };
        s.push_str(&format!(
            r#"<w:style w:type="paragraph" w:styleId="Heading{lv}"><w:name w:val="heading {lv}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="{before}" w:after="{after}" w:line="{line}" w:lineRule="auto"/><w:outlineLvl w:val="{ol}"/></w:pPr><w:rPr>{f}{bold}<w:color w:val="{color}"/><w:sz w:val="{sz}"/><w:szCs w:val="{sz}"/></w:rPr></w:style>"#,
            ol = lv - 1,
            f = fonts_tag(L::F_ASCII, cjk),
            sz = L::SZ_H[lv - 1],
            line = L::LINE_H[lv - 1]
        ));
    }

    s.push_str(&format!(
        r#"<w:style w:type="paragraph" w:styleId="CodeBlock"><w:name w:val="Code Block"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:rPr>{f}<w:sz w:val="{sz}"/><w:szCs w:val="{sz}"/></w:rPr></w:style>"#,
        f = fonts_tag(L::F_MONO, L::F_MONO_CJK),
        sz = L::SZ_CODE
    ));

    s.push_str(&format!(
        r#"<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:pBdr><w:left w:val="single" w:sz="18" w:space="10" w:color="{clay}"/></w:pBdr><w:ind w:left="340"/></w:pPr><w:rPr><w:color w:val="{soft}"/></w:rPr></w:style>"#,
        clay = L::C_CLAY,
        soft = L::C_INK_SOFT
    ));

    s.push_str(r#"<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="80"/><w:ind w:left="420"/><w:contextualSpacing/></w:pPr></w:style>"#);

    s.push_str(&format!(
        r#"<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="{clay}"/><w:u w:val="single"/></w:rPr></w:style>"#,
        clay = L::C_CLAY
    ));

    s.push_str(r#"<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:tblPr><w:tblCellMar><w:top w:w="60" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="60" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>"#);

    s.push_str("</w:styles>");
    s
}

/// 无序 / 有序各一套 abstractNum，9 级。
/// `w:numId` 与 `w:abstractNumId` 必须对上，正文里 numId=1 走项目符号、2 走编号。
fn numbering() -> String {
    let mut s = String::from(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">"#,
    );
    for (aid, ordered) in [(0usize, false), (1usize, true)] {
        s.push_str(&format!(
            r#"<w:abstractNum w:abstractNumId="{aid}"><w:multiLevelType w:val="hybridMultilevel"/>"#
        ));
        for lv in 0..9u32 {
            let ind = 420 + lv * 420;
            if ordered {
                let fmt = match lv % 3 {
                    0 => "decimal",
                    1 => "lowerLetter",
                    _ => "lowerRoman",
                };
                s.push_str(&format!(
                    r#"<w:lvl w:ilvl="{lv}"><w:start w:val="1"/><w:numFmt w:val="{fmt}"/><w:lvlText w:val="%{}."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="{ind}" w:hanging="420"/></w:pPr></w:lvl>"#,
                    lv + 1
                ));
            } else {
                // 项目符号的字形写成 XML 数字引用，别直接放字面字符：
                // 它们在 Symbol / Wingdings 的私用区（U+F0xx），源码里是不可见字符，
                // 极容易在复制粘贴或编码转换中丢掉——这里曾经就是空字符串，
                // 结果 Word 里整份文档的项目符号一个都不显示。
                let (ch, font) = match lv % 3 {
                    0 => ("&#xF0B7;", "Symbol"),      // ● 实心圆点
                    1 => ("o", "Courier New"),        // ○ 空心圈
                    _ => ("&#xF0A7;", "Wingdings"),   // ▪ 实心方块
                };
                s.push_str(&format!(
                    r#"<w:lvl w:ilvl="{lv}"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="{ch}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="{ind}" w:hanging="420"/></w:pPr><w:rPr><w:rFonts w:ascii="{font}" w:hAnsi="{font}" w:hint="default"/></w:rPr></w:lvl>"#
                ));
            }
        }
        s.push_str("</w:abstractNum>");
    }
    s.push_str(r#"<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num></w:numbering>"#);
    s
}

// ===================== 入口 =====================

pub fn build(ir: &DocIr) -> Result<Vec<u8>, String> {
    // rId1 = styles，rId2 = numbering，图片从 rId3 起，外链接在图片之后
    let rid_img_base = 2usize;
    let mut b = Builder {
        body: String::new(),
        links: Vec::new(),
        img_ids: ir.images.iter().map(|i| i.id.clone()).collect(),
        draw_id: 0,
        rid_img_base,
        in_quote: false,
    };
    for blk in &ir.blocks {
        b.block(blk);
    }

    let doc = format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><w:body>{body}<w:sectPr><w:pgSz w:w="{pw}" w:h="{ph}"/><w:pgMar w:top="{mv}" w:right="{mh}" w:bottom="{mv}" w:left="{mh}" w:header="851" w:footer="992" w:gutter="0"/><w:cols w:space="425"/><w:docGrid w:linePitch="312"/></w:sectPr></w:body></w:document>"#,
        body = b.body,
        pw = L::PAGE_W,
        ph = L::PAGE_H,
        mv = L::MAR_V,
        mh = L::MAR_H
    );

    let mut exts: Vec<String> = ir.images.iter().map(|i| i.ext.to_lowercase()).collect();
    exts.sort();
    exts.dedup();

    let mut z = zipw::Zip::new();
    z.add("[Content_Types].xml", content_types(&exts).as_bytes())?;
    z.add("_rels/.rels", root_rels().as_bytes())?;
    z.add("docProps/core.xml", core_props(&ir.title).as_bytes())?;
    z.add("word/document.xml", doc.as_bytes())?;
    z.add("word/styles.xml", styles().as_bytes())?;
    z.add("word/numbering.xml", numbering().as_bytes())?;
    z.add(
        "word/_rels/document.xml.rels",
        doc_rels(&ir.images, &b.links, rid_img_base).as_bytes(),
    )?;

    use base64::Engine;
    for (i, im) in ir.images.iter().enumerate() {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(im.data.as_bytes())
            .map_err(|e| format!("图片数据无效：{e}"))?;
        z.add(&format!("word/media/img{}.{}", i + 1, im.ext), &bytes)?;
    }

    Ok(z.finish())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(t: &str) -> Run {
        Run { text: t.to_string(), ..Default::default() }
    }

    #[test]
    fn esc_drops_xml_illegal_chars() {
        assert_eq!(esc("a&b<c>d\"e"), "a&amp;b&lt;c&gt;d&quot;e");
        // U+0000–U+0008 在 XML 1.0 里非法，必须丢掉而不是转义
        assert_eq!(esc("a\u{0}\u{1}\u{8}b"), "ab");
        // 制表 / 换行 / 回车是合法的，要留着
        assert_eq!(esc("a\tb\nc"), "a\tb\nc");
        // 中文不受影响
        assert_eq!(esc("中文—“引号”"), "中文—“引号”");
    }

    #[test]
    fn emu_conversion() {
        assert_eq!(emu(0), 0);
        assert_eq!(emu(96), 914_400); // 96px = 1 英寸
        assert_eq!(emu(600), 5_715_000);
    }

    #[test]
    fn page_geometry_matches_print_css() {
        // A4 与 @page margin:20mm 18mm 的换算
        assert_eq!(L::PAGE_W, 11906);
        assert_eq!(L::PAGE_H, 16838);
        assert_eq!(L::CONTENT_W, 11906 - 1021 * 2);
    }

    #[test]
    fn zip_structure_is_wellformed() {
        let mut z = zipw::Zip::new();
        z.add("a.txt", b"hello").unwrap();
        z.add("b/c.xml", b"<x/>").unwrap();
        let out = z.finish();
        // EOCD 在末尾 22 字节
        let eocd = &out[out.len() - 22..];
        assert_eq!(&eocd[0..4], &[0x50, 0x4b, 0x05, 0x06]);
        let n = u16::from_le_bytes([eocd[10], eocd[11]]);
        assert_eq!(n, 2, "条目数");
        let cd_off = u32::from_le_bytes([eocd[16], eocd[17], eocd[18], eocd[19]]) as usize;
        assert_eq!(&out[cd_off..cd_off + 4], &[0x50, 0x4b, 0x01, 0x02], "中央目录起点");
        assert_eq!(&out[0..4], &[0x50, 0x4b, 0x03, 0x04], "首条目的本地头");
    }

    #[test]
    fn heading_carries_outline_level() {
        // 大纲级别是 Word 导航窗格与自动目录的唯一依据，丢了整个「多级标题」就废了
        let s = styles();
        for lv in 1..=6 {
            assert!(
                s.contains(&format!(r#"<w:name w:val="heading {lv}"/>"#)),
                "缺内建名 heading {lv}"
            );
            assert!(
                s.contains(&format!(r#"<w:outlineLvl w:val="{}"/>"#, lv - 1)),
                "缺 outlineLvl {}",
                lv - 1
            );
        }
        // 中文必须走 eastAsia，只设 ascii 的话中文会掉回 Word 默认字体
        assert!(s.contains(&format!(r#"w:eastAsia="{}""#, L::F_CJK)));
        assert!(s.contains(&format!(r#"w:eastAsia="{}""#, L::F_CJK_SERIF)));
    }

    #[test]
    fn line_spacing_is_single_everywhere() {
        // 正文与标题都是单倍，按使用者反馈从 1.7 一路收下来的，
        // 有意不跟 @media print。谁为了「和 print 对齐」改回 408，会被这条挡住。
        assert_eq!(L::LINE, 240, "正文应为单倍行距");
        for lv in 0..6 {
            assert_eq!(L::LINE_H[lv], 240, "标题应为单倍行距");
        }
        let s = styles();
        assert!(!s.contains(r#"w:line="408""#), "不该再出现 1.7 倍行距");
        assert!(!s.contains(r#"w:line="360""#), "不该再出现 1.5 倍行距");
    }

    #[test]
    fn body_paragraph_spacing_is_five_points() {
        // 正文段前 / 段后各 5 磅。Word 把上一段的段后与下一段的段前**相加**
        // （不像 CSS 的 margin 会折叠），所以相邻两段之间实际是 10 磅。
        // 段落之间的呼吸全靠这个，行距是单倍不参与。
        assert_eq!(L::PARA_BEFORE, 100, "段前应为 5 磅");
        assert_eq!(L::PARA_AFTER, 100, "段后应为 5 磅");
        let s = styles();
        assert!(
            s.contains(r#"<w:spacing w:before="100" w:after="100" w:line="240" w:lineRule="auto"/>"#),
            "Normal 与 docDefaults 都要写上"
        );
        assert!(!s.contains(r#"w:after="240""#), "正文不该再是 12 磅段后");
    }

    #[test]
    fn bullet_glyphs_are_not_empty() {
        // 项目符号的字形在 Symbol / Wingdings 的私用区，源码里是不可见字符，
        // 极易在编辑中丢失。这里曾经是空字符串，结果 Word 里一个圆点都不显示。
        let n = numbering();
        assert!(n.contains(r#"<w:lvlText w:val="&#xF0B7;"/>"#), "一级缺实心圆点");
        assert!(n.contains(r#"<w:lvlText w:val="o"/>"#), "二级缺空心圈");
        assert!(n.contains(r#"<w:lvlText w:val="&#xF0A7;"/>"#), "三级缺实心方块");
        assert!(!n.contains(r#"<w:lvlText w:val=""/>"#), "项目符号字形不能为空");
    }

    #[test]
    fn code_block_gets_padding_from_a_cell() {
        // 段落底纹的边界就是文字的边界，给不出内边距；只有单元格的 tcMar 能。
        let mut b = Builder {
            body: String::new(), links: vec![], img_ids: vec![],
            draw_id: 0, rid_img_base: 2, in_quote: false,
        };
        b.block(&Block::Code { lang: "json".into(), lines: vec![vec![r("{}")]] });
        assert!(b.body.starts_with("<w:tbl>"), "代码块应包在表格里");
        assert!(b.body.contains(&format!(r#"<w:top w:w="{}" w:type="dxa"/>"#, L::CODE_PAD_V)));
        assert!(b.body.contains(&format!(r#"<w:left w:w="{}" w:type="dxa"/>"#, L::CODE_PAD_H)));
        assert!(b.body.contains(&format!(r#"w:fill="{}""#, L::C_CODE_BG)), "底色应由单元格出");
        // 代码块那张表不该带 TableGrid 样式——它不是数据表格，不加边框
        assert!(!b.body.contains(r#"<w:tblStyle w:val="TableGrid"/>"#));
    }

    #[test]
    fn ordered_lists_use_literal_numbers_not_word_autonumbering() {
        // Word 的自动编号会把全文所有有序列表串成一个序列一路递增：
        // 第二个列表接着上一个的号继续数。markdown 里每个列表是独立的，
        // 所以序号一律由前端算成字面文本写进正文。
        let items = vec![
            Item { level: 0, num: "1.".into(), runs: vec![r("甲")] },
            Item { level: 0, num: "2.".into(), runs: vec![r("乙")] },
            Item { level: 0, num: String::new(), runs: vec![r("无序")] },
        ];
        let mut b = Builder {
            body: String::new(), links: vec![], img_ids: vec![],
            draw_id: 0, rid_img_base: 2, in_quote: false,
        };
        b.block(&Block::List { items });
        // 有序项：字面序号 + 悬挂缩进，且不得出现 numPr
        assert!(b.body.contains("<w:t xml:space=\"preserve\">1.</w:t>"));
        assert!(b.body.contains("<w:t xml:space=\"preserve\">2.</w:t>"));
        assert!(b.body.contains(r#"<w:ind w:left="420" w:hanging="420"/>"#));
        // 无序项仍走 numbering.xml 的项目符号（项目符号没有递增问题）
        assert_eq!(b.body.matches(r#"<w:numId w:val="1"/>"#).count(), 1);
        assert!(!b.body.contains(r#"<w:numId w:val="2"/>"#), "不该再用编号型 numId");
    }

    #[test]
    fn table_has_all_six_borders() {
        let ir = DocIr {
            title: String::new(),
            images: vec![],
            blocks: vec![Block::Table {
                header: vec![vec![r("A")], vec![r("B")]],
                rows: vec![vec![vec![r("1")], vec![r("2")]]],
                align: vec![],
            }],
        };
        let mut b = Builder {
            body: String::new(),
            links: vec![],
            img_ids: vec![],
            draw_id: 0,
            rid_img_base: 2,
            in_quote: false,
        };
        for blk in &ir.blocks {
            b.block(blk);
        }
        for side in ["top", "left", "bottom", "right", "insideH", "insideV"] {
            assert!(
                b.body.contains(&format!(r#"<w:{side} w:val="single""#)),
                "表格的 {side} 边框应是实线"
            );
        }
        assert!(!b.body.contains(r#"w:val="none""#), "表格不该再有 none 边框");
    }

    #[test]
    fn numbering_ids_line_up() {
        let n = numbering();
        assert!(n.contains(r#"<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>"#));
        assert!(n.contains(r#"<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>"#));
        assert!(n.contains(r#"w:abstractNumId="0""#) && n.contains(r#"w:abstractNumId="1""#));
    }

    #[test]
    fn full_document_builds() {
        let ir = DocIr {
            title: "测试文档".into(),
            images: vec![],
            blocks: vec![
                Block::Heading { level: 1, runs: vec![r("制丝车间 WES")] },
                Block::Para {
                    runs: vec![
                        r("普通文本 "),
                        Run { text: "加粗".into(), b: true, ..Default::default() },
                        Run { text: "链接".into(), link: "https://a.b/c?d=1&e=2".into(), ..Default::default() },
                    ],
                },
                Block::Code {
                    lang: "json".into(),
                    lines: vec![vec![Run {
                        text: "  \"k\": 1".into(),
                        color: "9B4B2E".into(),
                        ..Default::default()
                    }]],
                },
                Block::List {
                    items: vec![Item { level: 0, num: "1.".into(), runs: vec![r("第一项")] }],
                },
                Block::Table {
                    header: vec![vec![r("列 A")], vec![r("列 B")]],
                    rows: vec![vec![vec![r("1")], vec![r("2")]]],
                    align: vec!["left".into(), "center".into()],
                },
                Block::Hr,
            ],
        };
        let out = build(&ir).unwrap();
        assert!(out.len() > 1000, "产物太小：{}", out.len());
        assert_eq!(&out[0..2], b"PK");

        // 外链必须登记成关系；正文里用 rId 引用
        let rels = doc_rels(&ir.images, &["https://a.b/c?d=1&e=2".to_string()], 2);
        assert!(rels.contains("TargetMode=\"External\""));
        assert!(rels.contains("d=1&amp;e=2"), "URL 里的 & 必须转义");
    }

    /// 吐一份内容尽量全的样张到临时目录，交给 `tools/check-docx.py` 校验
    /// zip 结构与每个 XML 的良构性。
    ///
    /// 「Word 说文件已损坏」绝大多数就出在这两处：zip 写坏，或者某个 part 的 XML
    /// 不良构（元素顺序错、标签没闭合、混进 XML 非法字符）。而 Word 不会告诉你
    /// 错在哪，所以必须在这一层先拦住。
    #[test]
    fn writes_sample_for_external_validation() {
        // 1x1 的透明 PNG
        let png1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk\
                      YPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
        let ir = DocIr {
            title: "样张 · 导出验证".into(),
            images: vec![ImageData {
                id: "img1".into(),
                data: png1x1.into(),
                ext: "png".into(),
            }],
            blocks: vec![
                Block::Heading { level: 1, runs: vec![r("一级标题 Heading")] },
                Block::Para {
                    runs: vec![
                        r("正文含"),
                        Run { text: "加粗".into(), b: true, ..Default::default() },
                        Run { text: "斜体".into(), i: true, ..Default::default() },
                        Run { text: "删除".into(), s: true, ..Default::default() },
                        Run { text: "code".into(), code: true, ..Default::default() },
                        Run { text: "链接".into(), link: "https://x.y/?a=1&b=<2>".into(), ..Default::default() },
                        Run { br: true, ..Default::default() },
                        r("软换行之后的内容，含控制字符\u{1}与引号\"—"),
                    ],
                },
                Block::Heading { level: 2, runs: vec![r("二级标题")] },
                Block::Quote {
                    blocks: vec![Block::Para { runs: vec![r("引用里的一段话")] }],
                },
                Block::Code {
                    lang: "json".into(),
                    lines: vec![
                        vec![Run { text: "{".into(), color: "6F6C63".into(), ..Default::default() }],
                        vec![Run { text: "  \"键\": <1>".into(), color: "5C7355".into(), ..Default::default() }],
                        vec![Run { text: "}".into(), color: "6F6C63".into(), ..Default::default() }],
                    ],
                },
                Block::Heading { level: 3, runs: vec![r("三级标题")] },
                Block::List {
                    items: vec![
                        Item { level: 0, num: String::new(), runs: vec![r("无序一层")] },
                        Item { level: 1, num: String::new(), runs: vec![r("无序二层")] },
                        Item { level: 0, num: "1.".into(), runs: vec![r("有序项")] },
                        Item { level: 0, num: "2.".into(), runs: vec![r("有序项二")] },
                    ],
                },
                Block::Table {
                    header: vec![vec![r("模块")], vec![r("职责")], vec![r("输出")]],
                    rows: vec![
                        vec![vec![r("工单")], vec![r("解析 & 排程")], vec![r("任务")]],
                        vec![vec![r("计时")], vec![r("超时预警")], vec![r("工艺状态")]],
                    ],
                    align: vec!["left".into(), "center".into(), "right".into()],
                },
                Block::Hr,
                Block::Image { id: "img1".into(), w: 600, h: 400, alt: "示意图".into() },
            ],
        };
        let out = build(&ir).unwrap();
        let p = std::env::temp_dir().join("clay_sample.docx");
        std::fs::write(&p, &out).unwrap();
        assert!(out.len() > 2000, "样张太小");
        eprintln!("样张已写到 {}", p.display());
    }

    #[test]
    fn image_ids_are_unique_and_nonzero() {
        let ir = DocIr {
            title: String::new(),
            images: vec![
                ImageData { id: "img1".into(), data: String::new(), ext: "png".into() },
                ImageData { id: "img2".into(), data: String::new(), ext: "png".into() },
            ],
            blocks: vec![
                Block::Image { id: "img1".into(), w: 600, h: 300, alt: String::new() },
                Block::Image { id: "img2".into(), w: 400, h: 200, alt: String::new() },
            ],
        };
        let mut b = Builder {
            body: String::new(),
            links: vec![],
            img_ids: vec!["img1".into(), "img2".into()],
            draw_id: 0,
            rid_img_base: 2,
            in_quote: false,
        };
        for blk in &ir.blocks {
            b.block(blk);
        }
        assert!(b.body.contains(r#"<wp:docPr id="1""#));
        assert!(b.body.contains(r#"<wp:docPr id="2""#));
        assert!(!b.body.contains(r#"id="0""#), "docPr id 不能是 0");
        // 图片从 rId3 起
        assert!(b.body.contains(r#"r:embed="rId3""#));
        assert!(b.body.contains(r#"r:embed="rId4""#));
        // extent 与 a:ext 必须一致
        assert_eq!(b.body.matches("cx=\"5715000\"").count(), 2);
    }
}
