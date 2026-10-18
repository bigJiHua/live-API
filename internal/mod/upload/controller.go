package upload

import (
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"

	"live/api/internal/resp"
)

// ============================================================================
// 文件上传控制器 —— from: controller/index.js
// ============================================================================

// computeFileHash 计算文件内容 SHA-256（🔄 2026-10-13 api.md P2-9：用于去重秒传）。
// 对应 Node computeFileHash：流式读取临时文件（压缩/移动之前算）。
func computeFileHash(filePath string) (string, error) {
	f, err := os.Open(filePath)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// dupResult 秒传命中时构造复用记录（对应 Node 5.6 节：physical 文件必须仍在才能复用）。
// remark/tags 取本次请求的值（Node 多文件分支即如此）；single 分支不含这两个键。
func dupResult(dup map[string]any, withRemarkTags bool, f uploadFormFields) map[string]any {
	dupPath := toStr(dup["file_path"])
	out := map[string]any{
		"id":        dup["id"],
		"url":       dupPath,
		"thumbnail": dupPath, // Node: dupIsImage ? dup.file_path : dup.file_path（等价）
		"fileName":  dup["file_name"],
		"fileSize":  dup["file_size"],
		"fileExt":   dup["file_ext"],
		"busId":     dup["bus_id"],
		"busType":   dup["bus_type"],
		"deduped":   true,
	}
	if withRemarkTags {
		out["remark"] = remarkOr(f.Remark)
		out["tags"] = tagsArrayOr(f.Tags)
	}
	return out
}

// tryDup 秒传去重：同一用户已上传过相同内容且物理文件仍在 ⇒ 返回复用记录（nil = 未命中）。
func tryDup(uid, fileHash string, file *stagedFile, f uploadFormFields, withRemarkTags bool) map[string]any {
	dup := FindByHash(uid, fileHash)
	if dup == nil || toStr(dup["file_path"]) == "" {
		return nil
	}
	dupPhysical := filepath.Join(uploadDir(), strings.TrimPrefix(toStr(dup["file_path"]), "/uploads/"))
	if _, err := os.Stat(dupPhysical); err != nil {
		return nil // 旧记录对应的物理文件已被删除，不能复用
	}
	removeQuiet(file.Path) // 删掉本次临时文件
	return dupResult(dup, withRemarkTags, f)
}

// uploadFormFields 从解析后的表单取字段（对应 req.body 的 destructure + 兼容键）。
type uploadFormFields struct {
	Type    string
	BusType string
	BusID   string
	Remark  string
	Tags    string
}

func parseFormFields(form *stagedForm) uploadFormFields {
	f := uploadFormFields{
		Type:    firstValue(form.Values["type"]),
		BusType: firstValue(form.Values["busType"]),
		BusID:   firstValue(form.Values["busId"]),
		Remark:  firstValue(form.Values["remark"]),
	}
	if f.Type == "" {
		f.Type = "image" // const { type = "image", ... }
	}
	if f.BusType == "" {
		f.BusType = firstValue(form.Values["bus_type"])
	}
	if f.BusType == "" {
		f.BusType = "other" // requestedBusType || bus_type || "other"
	}
	if f.BusID == "" {
		f.BusID = firstValue(form.Values["bus_id"])
	}
	// tags: Node 读 req.body.tags（数组或字符串）；本前端 FormData 用 "tags[]" 键，
	// Node 侧同样取不到 → "默认"，Go 保持一致只读 "tags" 键。
	f.Tags = firstValue(form.Values["tags"])
	return f
}

func firstValue(vals []string) string {
	if len(vals) > 0 {
		return vals[0]
	}
	return ""
}

// allowedTypesOf 对应 allowedMimeTypes[type] || allowedMimeTypes.image。
func allowedTypesOf(typ string) []string {
	if t, ok := allowedMimeTypes[typ]; ok {
		return t
	}
	return allowedMimeTypes["image"]
}

func contains(list []string, v string) bool {
	for _, item := range list {
		if item == v {
			return true
		}
	}
	return false
}

// validateRemarkTags 对应 remark/tags 长度校验（返回错误 message，空串表示通过）。
func validateRemarkTags(remark, tags string) string {
	if remark != "" && len([]rune(remark)) > maxRemarkLength {
		return "图片说明不能超过 " + strconv.Itoa(maxRemarkLength) + " 个字符"
	}
	if len([]rune(tags)) > maxTagsLength {
		return "标签总长度不能超过 " + strconv.Itoa(maxTagsLength) + " 个字符"
	}
	return ""
}

// Upload 单文件上传（图片按条件压缩为 WebP）。
// from: controller/index.js:145-346
func Upload(w http.ResponseWriter, r *http.Request) {
	uid := resp.UID(r)
	form, err := stageMultipart(r, "file", 1)
	if err != nil {
		resp.JSON(w, 500, map[string]any{"status": 500, "message": "上传失败"})
		return
	}
	f := parseFormFields(form)

	// 1. 校验文件是否存在
	if len(form.Files) == 0 {
		resp.JSON(w, 400, map[string]any{"status": 400, "message": "请选择要上传的文件"})
		return
	}
	file := form.Files[0]

	// 2. 校验文件类型
	allowedTypes := allowedTypesOf(f.Type)
	if !contains(allowedTypes, file.MimeType) {
		removeQuiet(file.Path)
		resp.JSON(w, 400, map[string]any{"status": 400,
			"message": "不支持的文件类型，仅支持: " + strings.Join(allowedTypes, ", ")})
		return
	}

	// 3. 校验 remark 长度
	if msg := validateRemarkTags(f.Remark, f.Tags); msg != "" {
		removeQuiet(file.Path)
		resp.JSON(w, 400, map[string]any{"status": 400, "message": msg})
		return
	}

	// 4. 校验文件大小（对应 multer limits.fileSize 10MB）
	if file.TooLarge || file.Size > maxFileSize {
		removeQuiet(file.Path)
		resp.JSON(w, 400, map[string]any{"status": 400, "message": "文件大小不能超过 10MB"})
		return
	}

	// 5.5 内容哈希（原图，压缩/移动之前算）
	fileHash, herr := computeFileHash(file.Path)
	if herr != nil {
		removeQuiet(file.Path)
		resp.JSON(w, 500, map[string]any{"status": 500, "message": "上传失败"})
		return
	}

	data, status, message := processSingleFile(file, uid, f, fileHash)
	if status != 200 {
		resp.JSON(w, status, map[string]any{"status": status, "message": message})
		return
	}
	msg := "上传成功"
	if message != "" {
		msg = message // 秒传命中："上传成功（秒传，复用已有文件）"
	}
	resp.JSON(w, 200, map[string]any{"status": 200, "message": msg, "data": data})
}

// processSingleFile 落盘 + 压缩 + 缩略图 + 写库（对应 upload() 的 6/7 步）。
// 🔄 2026-10-13（api.md P2-9）：孤儿文件修复 + 哈希去重秒传。
//
//	targetPath/thumbFullPath 提到作用域，任何失败路径统一清理（原实现只删临时文件，
//	已落盘的目标文件/缩略图变孤儿）；返回空 message 表示普通上传成功。
//
// 返回 (data, httpStatus, message)。
func processSingleFile(file *stagedFile, uid string, f uploadFormFields, fileHash string) (map[string]any, int, string) {
	allowedTypes := allowedTypesOf(f.Type)
	isImage := contains(allowedTypes, file.MimeType)
	isSvg := file.MimeType == "image/svg+xml"
	needCompress := file.Size > compressOverSize // 大于1MB才压缩
	webpOK := webpAvailable()

	// 5.6 秒传去重：同一用户已上传过相同内容 ⇒ 直接复用已有记录，不落新盘
	if dup := tryDup(uid, fileHash, file, f, false); dup != nil {
		return dup, 200, "上传成功（秒传，复用已有文件）"
	}

	// 6. 生成文件路径
	relativePath := generateFilePath(file.OrigName, f.BusType, isImage, webpOK)
	newFileName := path.Base(relativePath)
	targetPath := filepath.Join(uploadDir(), relativePath)

	// 孤儿清理：失败路径统一删除本次已落盘的目标文件/缩略图（对应 Node catch）
	var thumbFullPath string
	ok := false
	defer func() {
		if !ok {
			removeQuiet(targetPath)
			removeQuiet(thumbFullPath)
		}
	}()

	if err := ensureDir(filepath.Dir(targetPath)); err != nil {
		removeQuiet(file.Path)
		return nil, 500, "上传失败"
	}

	if isImage && !isSvg {
		if needCompress && webpOK {
			// 大于1MB：压缩为 WebP（ENV-002：无 cwebp 时不走该分支）
			finalSize, err := compressToWebp(file.Path, targetPath)
			if err != nil {
				removeQuiet(file.Path)
				return nil, 500, "上传失败"
			}
			removeQuiet(file.Path)

			// 立即生成缩略图
			thumbnailPath := generateThumbnail("/uploads/"+relativePath, f.BusType)
			thumbFullPath = thumbFullPathOf(thumbnailPath)

			id, err := Create(CreateParams{
				UserID: uid, BusID: nilIfEmpty(f.BusID), BusType: f.BusType,
				Remark: remarkOr(f.Remark), Tags: tagsOr(f.Tags),
				FileName: newFileName, FilePath: "/uploads/" + relativePath,
				FileSize: finalSize, FileExt: ".webp",
				FileHash: fileHash,
			})
			if err != nil {
				return nil, 500, "上传失败" // fix BUG-040：DB 失败返回错误（Node 恒 200）
			}
			ok = true
			return map[string]any{
				"id": id, "url": "/uploads/" + relativePath,
				"thumbnail": thumbOrEmpty(thumbnailPath),
				"fileName":  newFileName, "fileSize": finalSize, "fileExt": ".webp",
				"busId": nilIfEmpty(f.BusID), "busType": f.BusType, "compressed": true,
			}, 200, ""
		}
		// 小于1MB（或无 cwebp）：不压缩，直接移动
		if err := os.Rename(file.Path, targetPath); err != nil {
			removeQuiet(file.Path)
			return nil, 500, "上传失败"
		}
		finalSize := file.Size

		// 生成缩略图
		thumbnailPath := generateThumbnail("/uploads/"+relativePath, f.BusType)
		thumbFullPath = thumbFullPathOf(thumbnailPath)
		ext := strings.ToLower(path.Ext(newFileName))

		id, err := Create(CreateParams{
			UserID: uid, BusID: nilIfEmpty(f.BusID), BusType: f.BusType,
			Remark: remarkOr(f.Remark), Tags: tagsOr(f.Tags),
			FileName: newFileName, FilePath: "/uploads/" + relativePath,
			FileSize: finalSize, FileExt: ext,
			FileHash: fileHash,
		})
		if err != nil {
			return nil, 500, "上传失败"
		}
		ok = true
		return map[string]any{
			"id": id, "url": "/uploads/" + relativePath,
			"thumbnail": thumbOrEmpty(thumbnailPath),
			"fileName":  newFileName, "fileSize": finalSize, "fileExt": ext,
			"busId": nilIfEmpty(f.BusID), "busType": f.BusType, "compressed": false,
		}, 200, ""
	}

	// SVG 或非图片类型：直接移动，不生成缩略图
	if err := os.Rename(file.Path, targetPath); err != nil {
		removeQuiet(file.Path)
		return nil, 500, "上传失败"
	}
	finalSize := file.Size

	id, err := Create(CreateParams{
		UserID: uid, BusID: nilIfEmpty(f.BusID), BusType: f.BusType,
		Remark: remarkOr(f.Remark), Tags: tagsOr(f.Tags),
		FileName: newFileName, FilePath: "/uploads/" + relativePath,
		FileSize: finalSize, FileExt: path.Ext(newFileName),
		FileHash: fileHash,
	})
	if err != nil {
		return nil, 500, "上传失败"
	}
	ok = true
	return map[string]any{
		"id": id, "url": "/uploads/" + relativePath,
		"thumbnail": "/uploads/" + relativePath, // SVG 无缩略图，返回原图
		"fileName":  newFileName, "fileSize": finalSize, "fileExt": path.Ext(newFileName),
		"busId": nilIfEmpty(f.BusID), "busType": f.BusType,
	}, 200, ""
}

// thumbFullPathOf 缩略图相对路径 → 磁盘全路径（空串返回空串，删除时即无操作）。
// 对应 Node: thumbnailPath ? path.join(uploadDir, thumbnailPath.replace(/^uploads\//, "")) : null
func thumbFullPathOf(thumbnailPath string) string {
	if thumbnailPath == "" {
		return ""
	}
	return filepath.Join(uploadDir(), strings.TrimPrefix(thumbnailPath, "uploads/"))
}

// UploadMultiple 多文件上传（图片按条件压缩为 WebP）。
// from: controller/index.js:352-544
func UploadMultiple(w http.ResponseWriter, r *http.Request) {
	uid := resp.UID(r)
	form, err := stageMultipart(r, "files", 10)
	if err != nil {
		resp.JSON(w, 500, map[string]any{"status": 500, "message": "上传失败"})
		return
	}
	f := parseFormFields(form)

	// 校验 remark 长度 / tags 总长度（在读文件前，同 Node）
	if msg := validateRemarkTags(f.Remark, f.Tags); msg != "" {
		for _, file := range form.Files {
			removeQuiet(file.Path)
		}
		resp.JSON(w, 400, map[string]any{"status": 400, "message": msg})
		return
	}

	if len(form.Files) == 0 {
		resp.JSON(w, 400, map[string]any{"status": 400, "message": "请选择要上传的文件"})
		return
	}

	allowedTypes := allowedTypesOf(f.Type)
	results := []map[string]any{}
	errs := []string{}

	for _, file := range form.Files {
		// 校验类型和大小
		if !contains(allowedTypes, file.MimeType) {
			removeQuiet(file.Path)
			errs = append(errs, file.OrigName+": 不支持的文件类型")
			continue
		}
		if file.TooLarge || file.Size > maxFileSize {
			removeQuiet(file.Path)
			errs = append(errs, file.OrigName+": 文件过大")
			continue
		}

		// 🔄 2026-10-13（api.md P2-9）：内容哈希 + 秒传去重（压缩/移动之前算）
		fileHash, herr := computeFileHash(file.Path)
		if herr != nil {
			removeQuiet(file.Path)
			errs = append(errs, file.OrigName+": 上传失败")
			continue
		}

		// 🔄 2026-10-13（api.md P2-9）：单文件隔离 —— 单个文件失败（含 DB 写失败）
		//    只记入 errors 并清理该文件，不再中断整批 / 不再留孤儿文件
		//    （对齐 Node upload/controller/index.js:467-665 的 per-file try/catch）。
		data, ok := processMultipleFile(file, uid, f, allowedTypes, fileHash)
		if !ok {
			errs = append(errs, file.OrigName+": 上传失败")
			continue
		}
		results = append(results, data)
	}

	body := map[string]any{
		"status":  200,
		"message": "成功 " + strconv.Itoa(len(results)) + " 个，失败 " + strconv.Itoa(len(errs)) + " 个",
		"data":    results,
	}
	if len(errs) > 0 {
		body["errors"] = errs // Node: errors.length > 0 ? errors : undefined
	}
	resp.JSON(w, 200, body)
}

// processMultipleFile 对应 uploadMultiple 内联处理（单文件）。
// 🔄 2026-10-13（api.md P2-9）：单文件隔离 + 孤儿清理 + 秒传去重。
//
//	失败时清理本次已落盘的目标文件/缩略图/临时文件并返回 ok=false（由调用方记 errors 继续）；
//	返回 (result, ok)。
func processMultipleFile(file *stagedFile, uid string, f uploadFormFields, allowedTypes []string, fileHash string) (map[string]any, bool) {
	fail := func() (map[string]any, bool) {
		return nil, false
	}
	isImage := contains(allowedTypes, file.MimeType)
	isSvg := file.MimeType == "image/svg+xml"
	needCompress := file.Size > compressOverSize
	webpOK := webpAvailable()

	// 秒传去重：同一用户已上传过相同内容 ⇒ 直接复用已有记录，不落新盘
	if dup := tryDup(uid, fileHash, file, f, true); dup != nil {
		return dup, true
	}

	relativePath := generateFilePath(file.OrigName, f.BusType, isImage, webpOK)
	newFileName := path.Base(relativePath)
	targetPath := filepath.Join(uploadDir(), relativePath)

	// 孤儿清理：失败路径统一删除本次已落盘的目标文件/缩略图/临时文件（对应 Node per-file catch）
	var thumbFullPath string
	ok := false
	defer func() {
		if !ok {
			removeQuiet(targetPath)
			removeQuiet(thumbFullPath)
			removeQuiet(file.Path)
		}
	}()

	if err := ensureDir(filepath.Dir(targetPath)); err != nil {
		return fail()
	}

	if isImage && !isSvg {
		if needCompress && webpOK {
			finalSize, err := compressToWebp(file.Path, targetPath)
			if err != nil {
				return fail()
			}
			removeQuiet(file.Path)
			thumbnailPath := generateThumbnail("/uploads/"+relativePath, f.BusType)
			thumbFullPath = thumbFullPathOf(thumbnailPath)
			id, err := Create(CreateParams{
				UserID: uid, BusID: nilIfEmpty(f.BusID), BusType: f.BusType,
				Remark: remarkOr(f.Remark), Tags: tagsOr(f.Tags),
				FileName: newFileName, FilePath: "/uploads/" + relativePath,
				FileSize: finalSize, FileExt: ".webp",
				FileHash: fileHash,
			})
			if err != nil {
				return fail()
			}
			ok = true
			return map[string]any{
				"id": id, "url": "/uploads/" + relativePath,
				"thumbnail": thumbOrEmpty(thumbnailPath),
				"fileName":  newFileName, "fileSize": finalSize, "fileExt": ".webp",
				"busId": nilIfEmpty(f.BusID), "remark": remarkOr(f.Remark), "tags": tagsArrayOr(f.Tags),
				"compressed": true,
			}, true
		}
		if err := os.Rename(file.Path, targetPath); err != nil {
			return fail()
		}
		thumbnailPath := generateThumbnail("/uploads/"+relativePath, f.BusType)
		thumbFullPath = thumbFullPathOf(thumbnailPath)
		ext := strings.ToLower(path.Ext(newFileName))
		id, err := Create(CreateParams{
			UserID: uid, BusID: nilIfEmpty(f.BusID), BusType: f.BusType,
			Remark: remarkOr(f.Remark), Tags: tagsOr(f.Tags),
			FileName: newFileName, FilePath: "/uploads/" + relativePath,
			FileSize: file.Size, FileExt: ext,
			FileHash: fileHash,
		})
		if err != nil {
			return fail()
		}
		ok = true
		return map[string]any{
			"id": id, "url": "/uploads/" + relativePath,
			"thumbnail": thumbOrEmpty(thumbnailPath),
			"fileName":  newFileName, "fileSize": file.Size, "fileExt": ext,
			"busId": nilIfEmpty(f.BusID), "remark": remarkOr(f.Remark), "tags": tagsArrayOr(f.Tags),
			"compressed": false,
		}, true
	}

	// SVG 或非图片：直接移动，不转格式
	if err := os.Rename(file.Path, targetPath); err != nil {
		return fail()
	}
	ext := path.Ext(newFileName)
	if isSvg {
		ext = ".svg"
	} else {
		ext = strings.ToLower(ext)
	}
	id, err := Create(CreateParams{
		UserID: uid, BusID: nilIfEmpty(f.BusID), BusType: f.BusType,
		Remark: remarkOr(f.Remark), Tags: tagsOr(f.Tags),
		FileName: newFileName, FilePath: "/uploads/" + relativePath,
		FileSize: file.Size, FileExt: ext,
		FileHash: fileHash,
	})
	if err != nil {
		return fail()
	}
	ok = true
	return map[string]any{
		"id": id, "url": "/uploads/" + relativePath,
		"thumbnail": "/uploads/" + relativePath,
		"fileName":  newFileName, "fileSize": file.Size, "fileExt": ext,
		"busId": nilIfEmpty(f.BusID), "remark": remarkOr(f.Remark), "tags": tagsArrayOr(f.Tags),
		"compressed": false,
	}, true
}

// List 查询附件列表（自动生成缩略图）。
// from: controller/index.js:551-615
func List(w http.ResponseWriter, r *http.Request) {
	uid := resp.UID(r)
	q := r.URL.Query()
	busType := orDefault(q.Get("busType"), q.Get("bus_type"))
	resolvedBusID := orDefault(q.Get("busId"), q.Get("bus_id"))
	limit := jsParseInt(orDefault(q.Get("limit"), "50"))
	offset := jsParseInt(orDefault(q.Get("offset"), "0"))

	var attachments []map[string]any
	var err error
	if busType != "" && resolvedBusID != "" {
		attachments, err = FindByBus(busType, resolvedBusID, uid)
	} else {
		attachments, err = FindByUser(uid, busType, limit, offset)
	}
	if err != nil {
		resp.JSON(w, 500, map[string]any{"status": 500, "message": "查询失败"})
		return
	}

	results := make([]map[string]any, 0, len(attachments))
	for _, item := range attachments {
		ext := strings.ToLower(toStr(item["file_ext"]))
		isImage := isImageExts[ext]
		out := map[string]any{}
		for k, v := range item {
			out[k] = v
		}
		out["tags"] = tagsToArray(item["tags"])
		out["url"] = item["file_path"]
		if isImage {
			// fix BUG-041：统一判空（Node list 已判空；search/upload 未判空 → "/null"）
			thumbnail := generateThumbnail(toStr(item["file_path"]), toStr(item["bus_type"]))
			if thumbnail == "" {
				out["thumbnail"] = nil
			} else {
				out["thumbnail"] = "/" + thumbnail
			}
		} else {
			out["thumbnail"] = item["file_path"]
		}
		results = append(results, out)
	}
	resp.JSON(w, 200, map[string]any{"status": 200, "data": results})
}

// Search 搜索附件（按类型和关键词）。
// from: controller/index.js:623-685
func Search(w http.ResponseWriter, r *http.Request) {
	uid := resp.UID(r)
	q := r.URL.Query()
	limit := jsParseInt(orDefault(q.Get("limit"), "50"))
	offset := jsParseInt(orDefault(q.Get("offset"), "0"))

	attachments, err := searchAttachments(uid, orDefault(q.Get("type"), ""), orDefault(q.Get("key"), ""), limit, offset)
	if err != nil {
		resp.JSON(w, 500, map[string]any{"status": 500, "message": "搜索失败"})
		return
	}

	results := make([]map[string]any, 0, len(attachments))
	for _, item := range attachments {
		ext := strings.ToLower(toStr(item["file_ext"]))
		isImage := isImageExts[ext]
		out := map[string]any{
			"id":       item["id"],
			"bus_type": item["bus_type"],
			"remark":   item["remark"],
			"tags":     tagsToArray(item["tags"]),
		}
		if isImage {
			thumbnail := generateThumbnail(toStr(item["file_path"]), toStr(item["bus_type"]))
			if thumbnail == "" {
				out["thumbnail"] = nil // fix BUG-041：判空，不再返回 "/null"
			} else {
				out["thumbnail"] = "/" + thumbnail
			}
		} else {
			out["thumbnail"] = "/" + toStr(item["file_path"])
		}
		out["url"] = "/" + toStr(item["file_path"])
		results = append(results, out)
	}
	resp.JSON(w, 200, map[string]any{"status": 200, "data": results})
}

// Edit 编辑附件（修改 remark 和 tags）。
// from: controller/index.js:691-741
func Edit(w http.ResponseWriter, r *http.Request) {
	uid := resp.UID(r)
	id := r.PathValue("id")
	b := resp.Parse(r)

	remark := b.Raw["remark"]
	tags := b.Raw["tags"]

	remarkStr := toStr(remark)
	tagsStr := ""
	switch t := tags.(type) {
	case string:
		tagsStr = t
	case []any:
		parts := make([]string, 0, len(t))
		for _, v := range t {
			parts = append(parts, toStr(v))
		}
		tagsStr = strings.Join(parts, ",")
	}

	if msg := validateRemarkTags(remarkStr, tagsStr); msg != "" {
		resp.JSON(w, 400, map[string]any{"status": 400, "message": msg})
		return
	}

	// 查询附件信息
	attachment, err := FindById(id)
	if err != nil {
		resp.JSON(w, 500, map[string]any{"status": 500, "message": "编辑失败"})
		return
	}
	if attachment == nil {
		resp.JSON(w, 404, map[string]any{"status": 404, "message": "附件不存在"})
		return
	}

	// 校验权限
	if toStr(attachment["user_id"]) != uid {
		resp.JSON(w, 403, map[string]any{"status": 403, "message": "无权修改此附件"})
		return
	}

	if remark == nil && tags == nil {
		resp.JSON(w, 400, map[string]any{"status": 400, "message": "没有需要更新的字段"})
		return
	}

	status, err := Update(id, uid, remark, tags)
	if err != nil {
		resp.JSON(w, 500, map[string]any{"status": 500, "message": "更新失败"})
		return
	}
	switch status {
	case 400:
		resp.JSON(w, 400, map[string]any{"status": 400, "message": "没有需要更新的字段"})
	case 404:
		resp.JSON(w, 404, map[string]any{"status": 404, "message": "附件不存在或无权修改"})
	default:
		resp.JSON(w, 200, map[string]any{"status": 200, "message": "更新成功"})
	}
}

// BatchDelete 批量删除附件（引用检查 + 物理文件删除 + 硬删记录）。
// from: controller/index.js:747-819
func BatchDelete(w http.ResponseWriter, r *http.Request) {
	uid := resp.UID(r)
	b := resp.Parse(r)

	var ids []string
	if arr, ok := b.Raw["ids"].([]any); ok {
		for _, v := range arr {
			ids = append(ids, toStr(v))
		}
	}
	if len(ids) == 0 {
		resp.Say(w, "请选择要删除的附件", 400)
		return
	}

	// 检查附件是否被 moment 引用（fix BUG-006：补 user_id 过滤）
	check, err := CheckReferencesBeforeDelete(ids)
	if err != nil {
		resp.JSON(w, 500, map[string]any{"status": 500, "message": "批量删除失败"})
		return
	}

	// 如果有被引用的附件，返回提示
	if len(check.ReferencedIDs) > 0 {
		resp.JSON(w, 400, map[string]any{
			"status": 400, "message": "以下附件正在被动态使用，无法删除",
			"referencedIds": check.ReferencedIDs,
		})
		return
	}

	// 查询附件信息（仅本人）
	attachments := []map[string]any{}
	for _, id := range ids {
		attachment, err := FindById(id)
		if err != nil {
			resp.JSON(w, 500, map[string]any{"status": 500, "message": "批量删除失败"})
			return
		}
		if attachment != nil && toStr(attachment["user_id"]) == uid {
			attachments = append(attachments, attachment)
		}
	}

	// 删除物理文件（原图 + 缩略图）
	for _, attachment := range attachments {
		removeQuiet(filepath.Join(uploadDir(), strings.TrimPrefix(toStr(attachment["file_path"]), "/uploads/")))
		thumb := generateThumbPath(toStr(attachment["file_path"]), toStr(attachment["bus_type"]), ".webp")
		removeQuiet(filepath.Join(uploadDir(), thumb))
		// ENV-002 降级时缩略图可能是 .jpg，一并清理
		thumbJpg := generateThumbPath(toStr(attachment["file_path"]), toStr(attachment["bus_type"]), ".jpg")
		removeQuiet(filepath.Join(uploadDir(), thumbJpg))
	}

	// 硬删除数据库记录
	n, err := batchDeleteRows(ids, uid)
	if err != nil {
		if es, ok := err.(errStatus); ok {
			resp.JSON(w, es.status, map[string]any{"status": es.status, "message": es.message})
			return
		}
		resp.JSON(w, 500, map[string]any{"status": 500, "message": "批量删除失败"})
		return
	}
	resp.JSON(w, 200, map[string]any{"status": 200, "message": "已删除 " + strconv.FormatInt(n, 10) + " 个附件"})
}

// ===== 小助手 =====

func removeQuiet(p string) { _ = os.Remove(p) }

func orDefault(v, def string) string {
	if v == "" {
		return def
	}
	return v
}

// remarkOr 对应 `remark || "用户上传的图片"`。
func remarkOr(remark string) string {
	if remark == "" {
		return "用户上传的图片"
	}
	return remark
}

// tagsOr 对应 `tags || "默认"`。
func tagsOr(tags string) string {
	if tags == "" {
		return "默认"
	}
	return tags
}

// tagsArrayOr 对应响应里的 `tags: tags || "默认"`。
func tagsArrayOr(tags string) any {
	if tags == "" {
		return "默认"
	}
	return tags
}

// nilIfEmpty 对应 busId || null。
func nilIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// thumbOrEmpty 对应 fix BUG-041 后的统一判空：缩略图生成失败返回 null（与 list() 一致，不再 "/null"）。
func thumbOrEmpty(thumbnail string) any {
	if thumbnail == "" {
		return nil
	}
	return "/" + thumbnail
}
