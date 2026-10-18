package upload

import (
	"bytes"
	"image"
	"image/jpeg"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"

	"golang.org/x/image/draw"
	// 输入解码器注册（jpeg 由 image/jpeg 直接引用；gif/png/webp 供 image.Decode 识别）
	_ "image/gif"
	_ "image/png"

	_ "golang.org/x/image/webp"
)

// ============================================================================
// 缩略图生成与图片压缩 —— from: controller/index.js 的 generateThumbnail
// Node 用 sharp（内置预编译二进制）；Go 端 ENV-002 降级方案：
//   - 运行时探测 cwebp：有则外调 `cwebp -q 30 [-resize 200 200] in -o out.webp`；
//   - 无 cwebp 时用 x/image/draw 缩放 + image/jpeg 编码输出 .jpg，
//     thumbnail URL 相应指向 .jpg（文件名扩展随之变化，见 PLAN §6 差异清单）。
// ============================================================================

var (
	cwebpOnce sync.Once
	cwebpBin  string
	cwebpOK   bool
)

// probeCwebp 运行时探测 cwebp 二进制（ENV-001 同类启动探测，缺失时打日志标注）。
func probeCwebp() (string, bool) {
	cwebpOnce.Do(func() {
		if p, err := exec.LookPath("cwebp"); err == nil {
			cwebpBin, cwebpOK = p, true
			println("[upload] 探测到 cwebp: " + p + "（缩略图输出 .webp）")
		} else {
			cwebpOK = false
			println("[upload] 未探测到 cwebp（ENV-002 降级）：缩略图输出 .jpg，>1MB 图片不做 webp 转码")
		}
	})
	return cwebpBin, cwebpOK
}

// webpAvailable 原图是否按 Node 语义转 webp（有 cwebp 才转）。
func webpAvailable() bool {
	_, ok := probeCwebp()
	return ok
}

// generateThumbnail 对应 generateThumbnail(originalPath, busType)：
// 生成超压缩缩略图（最大 200x200，fit inside，不放大）。
// originalPath 形如 "/uploads/post/2026/09/22/xxx.webp"；返回相对 thumbPath 或 ""（null）。
// fix BUG-041：Node 版 search()/upload() 未判空把 null 拼成 "/null"；Go 统一返回空串由调用方判空。
func generateThumbnail(originalPath, busType string) string {
	ext := ".jpg"
	if _, ok := probeCwebp(); ok {
		ext = ".webp"
	}
	// 格式: uploads/temp/thumbs/busType/filename.webp（ENV-002 降级时为 .jpg）
	thumbPath := generateThumbPath(originalPath, busType, ext)
	// 去掉 uploads/ 前缀，避免路径重复
	cleanThumbPath := strings.TrimPrefix(thumbPath, "uploads/")
	fullThumbPath := filepath.Join(uploadDir(), cleanThumbPath)
	// 原图完整路径
	cleanOriginalPath := strings.TrimPrefix(originalPath, "/uploads/")
	fullOriginalPath := filepath.Join(uploadDir(), cleanOriginalPath)

	// 检查原文件是否存在
	if _, err := os.Stat(fullOriginalPath); err != nil {
		return ""
	}

	// 如果缩略图已存在，直接返回
	if _, err := os.Stat(fullThumbPath); err == nil {
		return thumbPath
	}

	// 确保缩略图目录存在
	if err := ensureDir(filepath.Dir(fullThumbPath)); err != nil {
		return ""
	}

	bin, ok := probeCwebp()
	if ok {
		// cwebp：质量 30，最大 200x200（fit inside，不放大）
		args := []string{"-q", "30"}
		if needResize(fullOriginalPath) {
			args = append(args, "-resize", "200", "200")
		}
		args = append(args, fullOriginalPath, "-o", fullThumbPath)
		cmd := exec.Command(bin, args...)
		if err := cmd.Run(); err != nil {
			return "" // 生成失败不阻塞，返回空（对应 Node 返回 null）
		}
		return thumbPath
	}

	// ENV-002 降级：x/image/draw 缩放 + image/jpeg 编码
	if err := writeJpegThumb(fullOriginalPath, fullThumbPath); err != nil {
		return ""
	}
	return thumbPath
}

// needResize 原图任一边超过 200 才缩放（对应 sharp withoutEnlargement: true）。
func needResize(fullOriginalPath string) bool {
	f, err := os.Open(fullOriginalPath)
	if err != nil {
		return false
	}
	defer f.Close()
	cfg, _, err := image.DecodeConfig(f)
	if err != nil {
		return false
	}
	return cfg.Width > thumbSize || cfg.Height > thumbSize
}

// writeJpegThumb 解码原图 → 等比缩放（fit inside 200x200，不放大）→ JPEG 编码。
// 注：sharp 的 .rotate() 会按 EXIF 方向旋转，Go 端 stdlib 解码不应用 EXIF，此处不做（差异记录）。
func writeJpegThumb(srcPath, dstPath string) error {
	f, err := os.Open(srcPath)
	if err != nil {
		return err
	}
	defer f.Close()
	img, format, err := image.Decode(f)
	if err != nil {
		_ = format
		return err
	}
	b := img.Bounds()
	w, h := b.Dx(), b.Dy()
	if w > thumbSize || h > thumbSize {
		scale := float64(thumbSize) / float64(w)
		if h > w {
			scale = float64(thumbSize) / float64(h)
		}
		nw, nh := int(float64(w)*scale), int(float64(h)*scale)
		if nw < 1 {
			nw = 1
		}
		if nh < 1 {
			nh = 1
		}
		dst := image.NewRGBA(image.Rect(0, 0, nw, nh))
		draw.CatmullRom.Scale(dst, dst.Bounds(), img, b, draw.Over, nil)
		img = dst
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: 75}); err != nil {
		return err
	}
	return os.WriteFile(dstPath, buf.Bytes(), 0o644)
}

// compressToWebp 大于 1MB 的图片压缩为 webp（q50，对应 sharp toFormat("webp", {quality:50})）。
// 仅在 cwebp 可用时调用；返回输出文件大小。
func compressToWebp(srcPath, dstPath string) (int64, error) {
	bin, ok := probeCwebp()
	if !ok {
		return 0, errNoCwebp
	}
	cmd := exec.Command(bin, "-q", "50", srcPath, "-o", dstPath)
	if err := cmd.Run(); err != nil {
		return 0, err
	}
	st, err := os.Stat(dstPath)
	if err != nil {
		return 0, err
	}
	return st.Size(), nil
}

type cwebpMissingError struct{}

func (cwebpMissingError) Error() string { return "cwebp 不可用" }

var errNoCwebp = cwebpMissingError{}
