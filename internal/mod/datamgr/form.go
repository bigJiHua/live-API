package datamgr

import (
	"crypto/rand"
	"errors"
	"io"
	"math/big"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// rand6 6 位 base36 随机串（对应 Math.random().toString(36).substring(2, 8) 的用途；
// crypto/rand 实现，fix BUG-008 同类）。
func rand6() string {
	const chars = "0123456789abcdefghijklmnopqrstuvwxyz"
	b := make([]byte, 6)
	for i := range b {
		n, err := rand.Int(rand.Reader, big.NewInt(int64(len(chars))))
		if err != nil {
			panic(err)
		}
		b[i] = chars[n.Int64()]
	}
	return string(b)
}

// ===== multipart 解析（复刻 api/index.js 的 multer({dest: uploadDir})） =====
// Node: const upload = multer({ dest: path.join(process.cwd(), 'data', 'uploads') });
// 🔧 SYNC-A41（2026-10-13）：10MB → 100MB，与 controller.go 的 maxFileSize 及
// Node 的 `MAX_FILE_SIZE = 100*1024*1024`（dataManager/controller/index.js:185）三者对齐。
//
// 此前的不一致（SYNC-A27 回退 BUG-013 时只改了 controller 的常量，漏了这道闸）：
// controller 宣称 100MB，流式落盘阶段却按 10MB 标记 TooLarge 并删盘，
// 最终有效上限仍是 10MB，而报错文案写着「文件超过 100MB 限制」—— 阈值与文案双错。
// 结果：10~100MB 的合法全库备份 SQL 一律被判 400，POST /import/sql 对大库不可用。
const maxImportFileSize = 100 * 1024 * 1024

// stagedFile 暂存的上传文件。
type stagedFile struct {
	Path     string
	Size     int64
	MimeType string
	OrigName string
	TooLarge bool
}

// stagedForm 解析后的表单。
type stagedForm struct {
	Values map[string][]string
	Files  []*stagedFile
}

// uploadDir data/uploads（对应 api/index.js 的 uploadDir）。
func uploadDir() string {
	dir := filepath.Join("data", "uploads")
	_ = os.MkdirAll(dir, 0o755)
	return dir
}

// stageMultipart 流式解析 multipart：文件落盘 data/uploads，字段收集为多值 map。
func stageMultipart(r *http.Request, field string, maxFiles int) (*stagedForm, error) {
	if err := os.MkdirAll(uploadDir(), 0o755); err != nil {
		return nil, err
	}
	mr, err := r.MultipartReader()
	if err != nil {
		return nil, err
	}
	form := &stagedForm{Values: map[string][]string{}}
	for {
		part, err := mr.NextPart()
		if err != nil {
			if errors.Is(err, io.EOF) {
				break
			}
			return form, nil
		}
		if part.FormName() != field || part.FileName() == "" {
			buf := make([]byte, 1<<20)
			var sb strings.Builder
			for {
				n, e := part.Read(buf)
				if n > 0 {
					sb.Write(buf[:n])
				}
				if e != nil {
					break
				}
			}
			form.Values[part.FormName()] = append(form.Values[part.FormName()], sb.String())
			part.Close()
			continue
		}
		if maxFiles > 0 && len(form.Files) >= maxFiles {
			part.Close()
			continue
		}
		ext := strings.ToLower(path.Ext(part.FileName()))
		name := "upload_" + strconv.FormatInt(time.Now().UnixMilli(), 10) + "_" + rand6() + ext
		full := filepath.Join(uploadDir(), name)
		f, err := os.Create(full)
		if err != nil {
			part.Close()
			return form, err
		}
		sf := &stagedFile{Path: full, MimeType: part.Header.Get("Content-Type"), OrigName: part.FileName()}
		form.Files = append(form.Files, sf)
		buf := make([]byte, 64<<10)
		for {
			n, e := part.Read(buf)
			if n > 0 {
				if !sf.TooLarge {
					if sf.Size+int64(n) > maxImportFileSize {
						sf.TooLarge = true
						continue
					}
					if _, werr := f.Write(buf[:n]); werr != nil {
						part.Close()
						f.Close()
						return form, werr
					}
					sf.Size += int64(n)
				}
			}
			if e != nil {
				break
			}
		}
		f.Close()
		part.Close()
		if sf.TooLarge {
			_ = os.Remove(full)
		}
	}
	return form, nil
}
