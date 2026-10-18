package upload

import (
	"crypto/rand"
	"encoding/json"
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

	"live/api/internal/config"
	"live/api/internal/db"
)

// ===== 配置（对应 UploadController.config） =====

const (
	maxFileSize      = 10 * 1024 * 1024 // 文件大小限制（字节）默认 10MB
	maxRemarkLength  = 50               // remark 最大字符数
	maxTagsLength    = 100              // tags 总字符数限制
	compressOverSize = 1024 * 1024      // 大于 1MB 才压缩（对应 needCompress）
	thumbSize        = 200              // 缩略图最大边长 200x200
)

// allowedMimeTypes 允许的文件类型（对应 Node config.allowedMimeTypes）。
var allowedMimeTypes = map[string][]string{
	"image": {"image/jpeg", "image/png", "image/gif", "image/webp", "image/svg+xml"},
	"file": {
		"application/pdf",
		"application/msword",
		"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	},
	"video": {"video/mp4", "video/webm", "video/ogg"},
	"audio": {"audio/mpeg", "audio/wav", "audio/ogg"},
}

// isImageExts 对应 list()/search() 的图片后缀判断。
var isImageExts = map[string]bool{".webp": true, ".jpg": true, ".jpeg": true, ".png": true, ".gif": true}

// uploadDir 存储根目录（对应 path.join(process.cwd(), "public", "uploads")）。
func uploadDir() string { return config.PathUnder(filepath.Join("public", "uploads")) }

// tempDir 临时目录（对应 multer diskStorage 的 destination）。
func tempDir() string { return filepath.Join(uploadDir(), "temp") }

func ensureDir(dir string) error {
	return os.MkdirAll(dir, 0o755)
}

// ===== multipart 解析（复刻 multer diskStorage + limits） =====

// stagedFile 暂存到 temp 目录的上传文件。
type stagedFile struct {
	Path     string // 临时文件绝对路径
	Size     int64
	MimeType string
	OrigName string
	TooLarge bool // 超过 10MB（对应 multer limits.fileSize）
}

// stagedForm 解析后的表单：字段值 + 暂存文件。
type stagedForm struct {
	Values map[string][]string // 普通字段（保留多值，对应 multer 的 req.body 数组语义）
	Files  []*stagedFile
}

// stageMultipart 流式解析 multipart：文件写入 temp 目录（文件名规则同 multer：
// temp_${Date.now()}_${random6}${ext}），普通字段收集为多值 map。
// 单文件超过 10MB 标记 TooLarge（继续读完以排空请求体）。
func stageMultipart(r *http.Request, field string, maxFiles int) (*stagedForm, error) {
	if err := ensureDir(tempDir()); err != nil {
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
			return form, nil // 解析到一半出错：按 Node multer 失败语义忽略后续
		}
		if part.FormName() != field || part.FileName() == "" {
			// 普通字段（multer 会把它们放进 req.body）
			buf := make([]byte, 1<<20)
			n, _ := part.Read(buf)
			form.Values[part.FormName()] = append(form.Values[part.FormName()], string(buf[:n]))
			// 读尽该 part（字段通常 < 1MB）
			for {
				m, e := part.Read(buf)
				if m > 0 {
					form.Values[part.FormName()][len(form.Values[part.FormName()])-1] += string(buf[:m])
				}
				if e != nil {
					break
				}
			}
			part.Close()
			continue
		}
		if maxFiles > 0 && len(form.Files) >= maxFiles {
			// 超出数量上限：忽略多余文件（对应 multer.array(files, 10) 的截断语义近似）
			part.Close()
			continue
		}
		ext := strings.ToLower(path.Ext(part.FileName()))
		name := "temp_" + strconv.FormatInt(time.Now().UnixMilli(), 10) + "_" + rand6() + ext
		full := filepath.Join(tempDir(), name)
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
					if sf.Size+int64(n) > maxFileSize {
						sf.TooLarge = true
						sf.Size += int64(n)
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
			_ = os.Remove(full) // 超限文件直接删除（对应 multer 不落库）
		}
	}
	return form, nil
}

// rand6 对应 Math.random().toString(36).substring(2, 8)（crypto/rand，fix BUG-008 同类）。
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

// rand8 对应 Math.random().toString(36).substring(2, 10)（crypto/rand，fix BUG-008 同类）。
func rand8() string {
	const chars = "0123456789abcdefghijklmnopqrstuvwxyz"
	b := make([]byte, 8)
	for i := range b {
		n, err := rand.Int(rand.Reader, big.NewInt(int64(len(chars))))
		if err != nil {
			panic(err)
		}
		b[i] = chars[n.Int64()]
	}
	return string(b)
}

// ===== 路径生成 =====

// busTypeFolderMap 对应 generateFilePath 的映射（未知 → other）。
func busTypeFolder(busType string) string {
	switch busType {
	case "post":
		return "post"
	case "product":
		return "product"
	case "bank":
		return "bank"
	case "other":
		return "other"
	}
	return "other"
}

// generateFilePath 对应 generateFilePath(file, busType, isImage, webpOk)：
// 格式 {folder}/{YYYY}/{MM}/{DD}/{ts}_{rand8}{ext}（图片统一转 WebP；
// ENV-002 降级：无 cwebp 时保持源扩展名、不转码，由调用方决定 needCompress）。
func generateFilePath(origName, busType string, isImage, webpOk bool) string {
	folder := busTypeFolder(busType)
	now := time.Now()
	year := now.Format("2006")
	month := now.Format("01")
	day := now.Format("02")

	timestamp := time.Now().UnixMilli()
	baseName := strconv.FormatInt(timestamp, 10) + "_" + rand8()

	ext := strings.ToLower(path.Ext(origName))
	isSvg := ext == ".svg"
	finalExt := ext
	if !isSvg && isImage && webpOk {
		finalExt = ".webp"
	}
	return folder + "/" + year + "/" + month + "/" + day + "/" + baseName + finalExt
}

// generateThumbPath 对应 generateThumbPath(filePath, busType, ext)：
// uploads/temp/thumbs/{busType}/{baseName}{ext}。
func generateThumbPath(filePath, busType, ext string) string {
	base := strings.TrimSuffix(path.Base(filePath), path.Ext(filePath))
	return "uploads/temp/thumbs/" + busType + "/" + base + ext
}

// ===== 通用助手 =====

// queryRows 查询多行并转 []map（列名 → 值）。
func queryRows(ex db.Commiter, query string, args ...any) ([]map[string]any, error) {
	rows, err := ex.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	cols, err := rows.Columns()
	if err != nil {
		return nil, err
	}
	out := []map[string]any{}
	for rows.Next() {
		vals := make([]any, len(cols))
		ptrs := make([]any, len(cols))
		for i := range vals {
			ptrs[i] = &vals[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			return nil, err
		}
		m := make(map[string]any, len(cols))
		for i, c := range cols {
			m[c] = normVal(vals[i])
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// queryRow 查询首行；无行返回 (nil, nil)。
func queryRow(ex db.Commiter, query string, args ...any) (map[string]any, error) {
	rows, err := queryRows(ex, query, args...)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, nil
	}
	return rows[0], nil
}

// execAffected 执行写语句并返回 affectedRows。
func execAffected(ex db.Commiter, query string, args ...any) (int64, error) {
	res, err := ex.Exec(query, args...)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// normVal []byte→string；time.Time→Node JSON.stringify(Date) 的 UTC ISO 串。
func normVal(v any) any {
	switch t := v.(type) {
	case []byte:
		return string(t)
	case time.Time:
		return t.UTC().Format("2006-01-02T15:04:05.000Z")
	}
	return v
}

// toStr 对应 String(v) 常用子集。
func toStr(v any) string {
	switch t := v.(type) {
	case nil:
		return ""
	case string:
		return t
	case float64:
		return strconv.FormatFloat(t, 'f', -1, 64)
	case json.Number:
		return t.String()
	}
	return ""
}

// joinFields 拼接 SQL 片段。
func joinFields(fields []string) string { return strings.Join(fields, ", ") }

// jsonStringifyTags 对应 JSON.stringify(tags)（Node 传入数组；Go 端接受 []any/string）。
func jsonStringifyTags(tags any) any {
	switch t := tags.(type) {
	case string:
		return t
	case []any:
		b, err := json.Marshal(t)
		if err != nil {
			return `["默认"]`
		}
		return string(b)
	case []string:
		b, err := json.Marshal(t)
		if err != nil {
			return `["默认"]`
		}
		return string(b)
	}
	return `["默认"]`
}

// tagsToArray 对应 list()/search() 的 tags 解析：JSON 数组或逗号分隔串。
func tagsToArray(raw any) any {
	s := toStr(raw)
	if s == "" {
		return []string{"默认"}
	}
	var arr []string
	if err := json.Unmarshal([]byte(s), &arr); err == nil {
		return arr
	}
	return strings.Split(s, ",")
}

// jsParseInt 对应 parseInt(v, 10)：不可解析 → NaN → Go 以 0 表达。
func jsParseInt(s string) int {
	s = strings.TrimSpace(s)
	end := 0
	for i := 0; i < len(s); i++ {
		c := s[i]
		if (i == 0 && (c == '-' || c == '+')) || (c >= '0' && c <= '9') {
			end = i + 1
			continue
		}
		break
	}
	if end == 0 {
		return 0
	}
	n, err := strconv.Atoi(s[:end])
	if err != nil {
		return 0
	}
	return n
}
