mod docx;

use serde::Serialize;
use std::fs;
use std::sync::Mutex;
use tauri::window::Color;
use tauri::Emitter;
use tauri::Manager;

/// 启动时命令行带进来的文件路径（双击 .md 打开时由资源管理器传入）
struct StartupFile(Mutex<Option<String>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Doc {
    path: String,
    text: String,
    /// 原文件编码，保存时按原样写回，避免把 GBK 文档默默转成 UTF-8
    encoding: String,
    /// "crlf" | "lf"，同样原样写回，避免整个文件的 diff 炸掉
    eol: String,
}

/// 按字节探测编码。国内的 .md 可能是 UTF-8，也可能是 GBK/GB18030，
/// 一律当 UTF-8 读会得到满屏乱码，所以顺序是：BOM → 严格 UTF-8 → 统计探测。
fn decode(bytes: &[u8]) -> (String, String) {
    // 注意：decode_without_bom_handling 返回 (Cow<str>, bool) 两元组，
    // 不同于 decode() 的 (Cow<str>, &Encoding, bool) 三元组——
    // 这里编码已由调用方指定，不需要再回传「实际使用的编码」。
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        let (cow, _) = encoding_rs::UTF_8.decode_without_bom_handling(&bytes[3..]);
        return (cow.into_owned(), "utf-8-bom".to_string());
    }
    if bytes.starts_with(&[0xFF, 0xFE]) {
        let (cow, _) = encoding_rs::UTF_16LE.decode_without_bom_handling(&bytes[2..]);
        return (cow.into_owned(), "utf-16le".to_string());
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        let (cow, _) = encoding_rs::UTF_16BE.decode_without_bom_handling(&bytes[2..]);
        return (cow.into_owned(), "utf-16be".to_string());
    }
    // 严格 UTF-8：能过就一定是 UTF-8，不必再猜
    if let Ok(s) = std::str::from_utf8(bytes) {
        return (s.to_owned(), "utf-8".to_string());
    }
    // 走到这里说明不是合法 UTF-8，交给统计探测，中文场景基本落在 GBK/GB18030
    let mut det = chardetng::EncodingDetector::new();
    det.feed(bytes, true);
    let enc = det.guess(None, true);
    let (cow, used, _) = enc.decode(bytes);
    (cow.into_owned(), used.name().to_lowercase())
}

fn encode(text: &str, encoding: &str, eol: &str) -> Vec<u8> {
    let body = if eol == "crlf" {
        text.replace('\n', "\r\n")
    } else {
        text.to_string()
    };
    match encoding {
        "utf-8-bom" => {
            let mut v = vec![0xEF, 0xBB, 0xBF];
            v.extend_from_slice(body.as_bytes());
            v
        }
        "gbk" | "gb18030" | "gb2312" | "x-gbk" => {
            let (cow, _, _) = encoding_rs::GB18030.encode(&body);
            cow.into_owned()
        }
        "big5" => {
            let (cow, _, _) = encoding_rs::BIG5.encode(&body);
            cow.into_owned()
        }
        "utf-16le" => {
            let mut v = vec![0xFF, 0xFE];
            for u in body.encode_utf16() {
                v.extend_from_slice(&u.to_le_bytes());
            }
            v
        }
        "utf-16be" => {
            let mut v = vec![0xFE, 0xFF];
            for u in body.encode_utf16() {
                v.extend_from_slice(&u.to_be_bytes());
            }
            v
        }
        _ => body.into_bytes(),
    }
}

#[tauri::command]
fn read_doc(path: String) -> Result<Doc, String> {
    let bytes = fs::read(&path).map_err(|e| format!("读取失败：{e}"))?;
    let (raw, encoding) = decode(&bytes);
    let eol = if raw.contains("\r\n") { "crlf" } else { "lf" };
    Ok(Doc {
        path,
        // 前端统一按 \n 处理，保存时再按 eol 还原
        text: raw.replace("\r\n", "\n").replace('\r', "\n"),
        encoding,
        eol: eol.to_string(),
    })
}

#[tauri::command]
fn write_doc(path: String, text: String, encoding: String, eol: String) -> Result<(), String> {
    fs::write(&path, encode(&text, &encoding, &eol)).map_err(|e| format!("保存失败：{e}"))?;
    Ok(())
}

/// 导出 PDF：走 WebView2 的 ICoreWebView2_7::PrintToPdf，把当前页面直接渲染成
/// 文件，不弹系统打印对话框。
///
/// 版面完全由前端 `@media print` 那套样式决定——纸张尺寸这里给 A4 与 CSS 对齐，
/// 但**页边距不在这里设**：CSS 的 `@page` 已经设过一次，两边各设一次会叠加成
/// 双倍边距。单一来源才不会乱。
///
/// PrintToPdf 是异步的，完成回调在主线程跑。所以这里必须是 async command：
/// 同步阻塞等结果会把主线程占住，回调永远轮不到，直接死锁。
#[cfg(windows)]
#[tauri::command]
async fn export_pdf(window: tauri::WebviewWindow, path: String) -> Result<(), String> {
    use std::sync::{Arc, Mutex};
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Environment6, ICoreWebView2_7,
    };
    use webview2_com::PrintToPdfCompletedHandler;
    use windows::core::{Interface, PCWSTR};

    let (tx, mut rx) = tauri::async_runtime::channel::<Result<(), String>>(1);
    let tx = Arc::new(Mutex::new(Some(tx)));
    let tx_err = tx.clone();

    window
        .with_webview(move |webview| {
            // 路径转成以 NUL 结尾的 UTF-16。wide 必须活到 PrintToPdf 返回，
            // 所以留在本作用域里，别提前 drop。
            let wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();

            let run = || -> windows::core::Result<()> {
                unsafe {
                    let core = webview.controller().CoreWebView2()?;
                    let wv7: ICoreWebView2_7 = core.cast()?;
                    let env6: ICoreWebView2Environment6 = webview.environment().cast()?;
                    let st = env6.CreatePrintSettings()?;

                    // A4，单位是英寸
                    st.SetPageWidth(8.27)?;
                    st.SetPageHeight(11.69)?;
                    // 代码块灰底、表头分隔线都算「背景」，不开这项会被丢掉
                    st.SetShouldPrintBackgrounds(true)?;
                    // 浏览器默认页眉页脚是 URL 和日期，软著/投标材料里不该出现
                    st.SetShouldPrintHeaderAndFooter(false)?;

                    let tx_ok = tx.clone();
                    let handler = PrintToPdfCompletedHandler::create(Box::new(move |hr, ok| {
                        let r = if ok {
                            Ok(())
                        } else {
                            Err(format!("WebView2 写入 PDF 失败（HRESULT {hr:?}）"))
                        };
                        if let Some(t) = tx_ok.lock().unwrap().take() {
                            let _ = t.try_send(r);
                        }
                        Ok(())
                    }));
                    wv7.PrintToPdf(PCWSTR(wide.as_ptr()), &st, &handler)?;
                }
                Ok(())
            };

            if let Err(e) = run() {
                if let Some(t) = tx_err.lock().unwrap().take() {
                    let _ = t.try_send(Err(format!("导出失败：{e}")));
                }
            }
        })
        .map_err(|e| format!("取不到 WebView2 句柄：{e}"))?;

    rx.recv().await.unwrap_or(Err("导出没有返回结果".to_string()))
}

/// 非 Windows 平台没有 WebView2，本项目只面向 Windows，这里留个明确的报错，
/// 免得 generate_handler! 里还要分平台注册。
#[cfg(not(windows))]
#[tauri::command]
async fn export_pdf(_window: tauri::WebviewWindow, _path: String) -> Result<(), String> {
    Err("PDF 导出目前只支持 Windows".to_string())
}

/// 导出 .docx。markdown 已在前端解析成 IR（见 src/js/word.js），这里只做
/// 「IR → OOXML → zip → 落盘」。
///
/// 与 export_pdf 不同，这个**不需要 async**：没有 WebView2 的异步回调，
/// 纯计算加一次写文件，同步跑反而少一层 await。
#[tauri::command]
fn export_docx(path: String, doc: docx::DocIr) -> Result<(), String> {
    let bytes = docx::build(&doc)?;
    fs::write(&path, bytes).map_err(|e| format!("保存失败：{e}"))?;
    Ok(())
}

/// 图片目录约定：`笔记.md` 配 `笔记.assets/`。
/// 用文件名做前缀而不是统一叫 assets/，同一目录下放多个 md 时才不会混在一起。
fn assets_dir(doc_path: &str) -> Option<(std::path::PathBuf, String)> {
    let p = std::path::Path::new(doc_path);
    let stem = p.file_stem()?.to_string_lossy().to_string();
    let dir = p.parent()?.join(format!("{stem}.assets"));
    Some((dir, stem))
}

/// 存一张图（粘贴进来的），返回可直接写进 md 的相对路径
#[tauri::command]
fn save_image(doc_path: String, name: String, data: String) -> Result<String, String> {
    use base64::Engine;
    let (dir, stem) = assets_dir(&doc_path).ok_or("文档路径无效")?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("建图片目录失败：{e}"))?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.as_bytes())
        .map_err(|e| format!("图片数据无效：{e}"))?;
    std::fs::write(dir.join(&name), bytes).map_err(|e| format!("写入图片失败：{e}"))?;
    // md 里一律用正斜杠：Windows 认它，换到别的系统也不会瞎
    Ok(format!("{stem}.assets/{name}"))
}

/// 把磁盘上已有的图片拷进 assets 目录（拖进来或对话框选的）
#[tauri::command]
fn import_image(doc_path: String, from: String, name: String) -> Result<String, String> {
    let (dir, stem) = assets_dir(&doc_path).ok_or("文档路径无效")?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("建图片目录失败：{e}"))?;
    std::fs::copy(&from, dir.join(&name)).map_err(|e| format!("复制图片失败：{e}"))?;
    Ok(format!("{stem}.assets/{name}"))
}

/// 读图片给预览用。
/// 预览页的 base URL 是 tauri://localhost，md 里的相对路径在 webview 里根本
/// 解析不到，只能由这边读成 data URL 交过去。
/// 把 md 里的相对路径按「文档所在目录」解析成绝对路径。绝对路径原样返回。
/// 图片和文档间跳转共用这一套，免得两边规则各写一份、慢慢分叉。
fn resolve_relative(doc_path: &str, rel: &str) -> Option<std::path::PathBuf> {
    let raw = std::path::Path::new(rel);
    if raw.is_absolute() {
        return Some(raw.to_path_buf());
    }
    Some(std::path::Path::new(doc_path).parent()?.join(raw))
}

/// Windows 的 canonicalize 会返回 `\\?\E:\...` 这种扩展长度前缀，
/// 直接拿去当标签页的身份键会和别处的写法对不上（同一个文件开成两个标签）。
fn strip_verbatim(p: &std::path::Path) -> String {
    let raw = p.to_string_lossy().to_string();
    if let Some(t) = raw.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{t}");
    }
    match raw.strip_prefix(r"\\?\") {
        Some(t) => t.to_string(),
        None => raw,
    }
}

/// 点预览里的 `[说明](01-系统总览.md)` 时用：把相对链接解析成绝对路径。
/// 解析与存在性检查都放这边——Windows 的路径拼接（中文名、含点的文件名、`../`）
/// 正是本项目最容易翻车的地方，放 Rust 才有 cargo test 兜着。
#[tauri::command]
fn resolve_doc(doc_path: String, href: String) -> Result<String, String> {
    let abs = resolve_relative(&doc_path, &href).ok_or("当前文档路径无效")?;
    // canonicalize 顺带把 ../ 和大小写折平，同一个文件不会因写法不同开成两个标签
    let real = std::fs::canonicalize(&abs).map_err(|_| format!("找不到文件：{}", abs.display()))?;
    if !real.is_file() {
        return Err(format!("不是文件：{}", real.display()));
    }
    Ok(strip_verbatim(&real))
}

#[tauri::command]
fn read_image(doc_path: String, src: String) -> Result<String, String> {
    use base64::Engine;
    let abs = resolve_relative(&doc_path, &src).ok_or("文档路径无效")?;
    let bytes = std::fs::read(&abs).map_err(|e| format!("读不到图片：{e}"))?;
    let mime = match abs
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase()
        .as_str()
    {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        _ => "application/octet-stream",
    };
    Ok(format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

/// 递归复制目录。同名文件跳过而不是覆盖——目标目录里已有的东西不能动。
fn copy_dir_all(from: &std::path::Path, to: &std::path::Path) -> std::io::Result<u32> {
    std::fs::create_dir_all(to)?;
    let mut n = 0;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let dst = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            n += copy_dir_all(&entry.path(), &dst)?;
        } else if !dst.exists() {
            std::fs::copy(entry.path(), &dst)?;
            n += 1;
        }
    }
    Ok(n)
}

/// 另存为时把旧文档的图片目录复制到新文档名下。
///
/// 用复制而不是移动：另存为语义上是存一份副本，把目录移走会让原文件的图全断。
/// 返回是否真的复制了，前端据此决定要不要改写正文里的引用。
#[tauri::command]
fn copy_assets(old_doc: String, new_doc: String) -> Result<bool, String> {
    let (old_dir, _) = assets_dir(&old_doc).ok_or("旧文档路径无效")?;
    if !old_dir.is_dir() {
        return Ok(false); // 本来就没有图片目录
    }
    let (new_dir, _) = assets_dir(&new_doc).ok_or("新文档路径无效")?;
    if old_dir == new_dir {
        return Ok(false); // 同名同目录，什么都不用做
    }
    copy_dir_all(&old_dir, &new_dir).map_err(|e| format!("复制图片目录失败：{e}"))?;
    Ok(true)
}

/// 前端启动后来取一次；取走即清空，避免热重载时重复打开
#[tauri::command]
fn take_startup_file(state: tauri::State<StartupFile>) -> Option<String> {
    state.0.lock().ok()?.take()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 资源管理器双击 .md 时，路径作为第一个参数传进来
    let startup = std::env::args()
        .skip(1)
        .find(|a| !a.starts_with('-'))
        .filter(|p| std::path::Path::new(p).is_file());

    tauri::Builder::default()
        // 必须第一个注册。没有它的话，在资源管理器里双击第二个 .md 会另起一个进程、
        // 另开一个窗口——标签页就白做了。拦下来把路径转给已经在跑的那个窗口，
        // 前端收到 open-file 事件后开一个新标签。
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let path = argv
                .iter()
                .skip(1)
                .find(|a| !a.starts_with('-'))
                .filter(|p| std::path::Path::new(p.as_str()).is_file())
                .cloned();
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.unminimize();
                let _ = win.set_focus();
                if let Some(p) = path {
                    let _ = win.emit("open-file", p);
                }
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(move |app| {
            app.manage(StartupFile(Mutex::new(startup.clone())));
            // WebView2 初始化那一秒窗口里还什么都没有，底色由窗口自己出。
            // 配置里给的是浅色 --paper，系统处于深色时在这儿换成深色 --paper，
            // 否则深色模式启动会先闪一下白屏。
            if let Some(win) = app.get_webview_window("main") {
                if matches!(win.theme(), Ok(tauri::Theme::Dark)) {
                    let _ = win.set_background_color(Some(Color(0x1B, 0x1A, 0x18, 255)));
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            read_doc,
            write_doc,
            take_startup_file,
            export_pdf,
            export_docx,
            save_image,
            import_image,
            read_image,
            resolve_doc,
            copy_assets
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn assets_dir_follows_doc_name() {
        let (dir, stem) = assets_dir("E:/work/笔记.md").unwrap();
        assert_eq!(stem, "笔记");
        assert!(dir.ends_with("笔记.assets"), "got {dir:?}");
        assert!(dir.starts_with("E:/work"), "got {dir:?}");
        // 文件名含点时，只剥最后一段扩展名
        let (_, stem2) = assets_dir("E:/work/v1.2.md").unwrap();
        assert_eq!(stem2, "v1.2");
    }

    /// 文档间跳转：`[说明](01-系统总览.md)` 要能解析到同目录的那个文件。
    /// 中文名、含点的文件名、`../` 上跳、子目录下跳，都是 Windows 上的老翻车点。
    #[test]
    fn resolve_doc_finds_sibling_documents() {
        let tmp = std::env::temp_dir().join("clay_link_test");
        let _ = std::fs::remove_dir_all(&tmp);
        let sub = tmp.join("子目录");
        std::fs::create_dir_all(&sub).unwrap();

        let doc = tmp.join("00-总纲.md");
        std::fs::write(&doc, "# t").unwrap();
        std::fs::write(tmp.join("01-系统总览.md"), "# a").unwrap();
        std::fs::write(tmp.join("v1.2-附录.md"), "# b").unwrap();
        std::fs::write(sub.join("明细.md"), "# c").unwrap();
        let docs = doc.to_string_lossy().to_string();

        for rel in ["01-系统总览.md", "v1.2-附录.md", "子目录/明细.md"] {
            let got = resolve_doc(docs.clone(), rel.to_string())
                .unwrap_or_else(|e| panic!("{rel} 应当解析成功，实际：{e}"));
            assert!(!got.starts_with(r"\\?\"), "不该带扩展长度前缀：{got}");
            assert!(std::path::Path::new(&got).is_file(), "解析结果应是真文件：{got}");
        }

        // 从子目录里的文档用 ../ 跳回上级
        let inner = sub.join("明细.md").to_string_lossy().to_string();
        let up = resolve_doc(inner, "../01-系统总览.md".into()).unwrap();
        assert!(up.ends_with("01-系统总览.md"), "got {up}");
        assert!(!up.contains(".."), "../ 应当被折平，否则同一文件会开成两个标签：{up}");

        // 不存在的目标要报错而不是返回一个假路径
        assert!(resolve_doc(docs.clone(), "不存在.md".into()).is_err());
        // 目录不是文件
        assert!(resolve_doc(docs, "子目录".into()).is_err());

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn copy_assets_follows_rename() {
        let tmp = std::env::temp_dir().join("clay_copy_test");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let old_doc = tmp.join("未命名.md");
        let new_doc = tmp.join("正式名称.md");
        std::fs::write(&old_doc, "# t").unwrap();
        let old_assets = tmp.join("未命名.assets");
        std::fs::create_dir_all(&old_assets).unwrap();
        std::fs::write(old_assets.join("a.png"), b"fake").unwrap();
        std::fs::create_dir_all(old_assets.join("sub")).unwrap();
        std::fs::write(old_assets.join("sub").join("b.png"), b"fake2").unwrap();

        let copied = copy_assets(
            old_doc.to_string_lossy().to_string(),
            new_doc.to_string_lossy().to_string(),
        ).unwrap();
        assert!(copied, "应当复制");
        assert!(tmp.join("正式名称.assets").join("a.png").exists());
        assert!(tmp.join("正式名称.assets").join("sub").join("b.png").exists(), "子目录也要跟过去");
        assert!(old_assets.join("a.png").exists(), "原目录必须保留，不能是移动");

        // 没有图片目录时应安静返回 false
        let bare = tmp.join("没有图.md");
        std::fs::write(&bare, "# t").unwrap();
        assert!(!copy_assets(
            bare.to_string_lossy().to_string(),
            new_doc.to_string_lossy().to_string()
        ).unwrap());

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn read_real_screenshot() {
        let doc = "C:/Users/12297/Desktop/c/wes技术协议.md";
        if !std::path::Path::new(doc).exists() { return; }   // 文件不在就跳过
        let rel = "wes技术协议.assets/20260916-114230-509.png";
        let url = read_image(doc.to_string(), rel.to_string()).expect("应能读到真实截图");
        assert!(url.starts_with("data:image/png;base64,"), "data URL 开头不对");
        assert!(url.len() > 10000, "data URL 太短：{}", url.len());
        // 失配的那条引用应当报错而不是 panic
        assert!(read_image(doc.to_string(),
                "未命名.assets/20260916-114045-542.png".to_string()).is_err());
    }

    #[test]
    fn save_then_read_roundtrip() {
        use base64::Engine;
        let tmp = std::env::temp_dir().join("clay_img_test");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let doc = tmp.join("测试文档.md");
        std::fs::write(&doc, "# t").unwrap();
        let doc_s = doc.to_string_lossy().to_string();

        // 1x1 PNG
        let png: &[u8] = &[137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,1,0,0,0,1,
                           8,6,0,0,0,31,21,196,137,0,0,0,10,73,68,65,84,120,156,99,0,1,0,0,5,0,1,
                           13,10,45,180,0,0,0,0,73,69,78,68,174,66,96,130];
        let b64 = base64::engine::general_purpose::STANDARD.encode(png);
        let rel = save_image(doc_s.clone(), "a.png".into(), b64).unwrap();
        assert_eq!(rel, "测试文档.assets/a.png", "返回的应是正斜杠相对路径");
        assert!(tmp.join("测试文档.assets").join("a.png").exists());

        // 用返回的相对路径能读回来，且是 png 的 data URL
        let url = read_image(doc_s.clone(), rel).unwrap();
        assert!(url.starts_with("data:image/png;base64,"), "got {}", &url[..40.min(url.len())]);

        // 读不存在的文件要报错而不是 panic
        assert!(read_image(doc_s, "没有这个.png".into()).is_err());
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
