package upload

import (
	"time"

	"live/api/internal/db"
	"live/api/internal/idgen"
)

// ============================================================================
// 文件附件模型 —— from: model/attachment.js（sys_attachment 表）
// ============================================================================

const tableName = "sys_attachment"

// CreateParams 对应 SysAttachment.create 入参。
type CreateParams struct {
	UserID   string
	BusID    any
	BusType  string
	Remark   any
	Tags     any
	FileName string
	FilePath string
	FileSize int64
	FileExt  string
	FileHash string // 🔄 2026-10-13（api.md P2-9）：SHA-256 内容哈希（秒传去重）
}

// Create 对应 SysAttachment.create，返回新记录 id。
// fix BUG-040：Node 版 DB 写失败仍返回 {status:500} 且 controller 恒 200（孤儿文件）；
// Go 版失败以 error 向上传播，由 controller 返回 500。
func Create(p CreateParams) (string, error) {
	id := idgen.NanoID(21)
	createTime := time.Now().UnixMilli()

	tagsVal := any(`["默认"]`)
	if t := toStr(p.Tags); t != "" {
		tagsVal = t // Node: tags ? JSON.stringify(tags) : JSON.stringify(["默认"])
	}
	remark := "用户上传的图片"
	if r := toStr(p.Remark); r != "" {
		remark = r // Node: remark || "用户上传的图片"
	}
	var busID any
	if s := toStr(p.BusID); s != "" {
		busID = s // Node: busId || null
	}
	var fileHash any
	if p.FileHash != "" {
		fileHash = p.FileHash // Node: fileHash || null
	}

	_, err := db.DB().Exec(
		`INSERT INTO `+tableName+`
        (id, user_id, bus_id, bus_type, remark, tags, file_name, file_path, file_size, file_ext, file_hash, create_time, is_deleted)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
		id, p.UserID, busID, p.BusType, remark, tagsVal,
		p.FileName, p.FilePath, p.FileSize, p.FileExt, fileHash, createTime)
	if err != nil {
		return "", err
	}
	return id, nil
}

// FindByHash 对应 SysAttachment.findByHash(userId, fileHash)：
// 🔄 2026-10-13（api.md P2-9）：按 user_id + file_hash 查已有附件（秒传去重）。
// file_hash 列尚未迁移到位时不阻断上传（降级为不去重）——对应 Node try/catch 返 null。
func FindByHash(userID, fileHash string) map[string]any {
	if fileHash == "" {
		return nil
	}
	row, err := queryRow(db.DB(),
		`SELECT * FROM `+tableName+`
        WHERE user_id = ? AND file_hash = ? AND is_deleted = 0
        ORDER BY create_time DESC LIMIT 1`,
		userID, fileHash)
	if err != nil {
		println("[SysAttachment] findByHash 失败（降级不去重）:", err.Error())
		return nil
	}
	return row
}

// FindByBus 对应 SysAttachment.findByBus(busType, busId, userId)。
func FindByBus(busType, busID, userID string) ([]map[string]any, error) {
	return queryRows(db.DB(),
		`SELECT * FROM `+tableName+`
        WHERE bus_type = ? AND bus_id = ? AND user_id = ? AND is_deleted = 0
        ORDER BY create_time DESC`,
		busType, busID, userID)
}

// FindByUser 对应 SysAttachment.findByUser(userId, {busType, limit, offset})。
func FindByUser(userID, busType string, limit, offset int) ([]map[string]any, error) {
	query := `SELECT * FROM ` + tableName + `
        WHERE user_id = ? AND is_deleted = 0`
	params := []any{userID}
	if busType != "" {
		query += ` AND bus_type = ?`
		params = append(params, busType)
	}
	query += ` ORDER BY create_time DESC LIMIT ? OFFSET ?`
	params = append(params, limit, offset)
	return queryRows(db.DB(), query, params...)
}

// FindById 对应 SysAttachment.findById(id)（注意：无 user_id 过滤，同 Node 原样）。
func FindById(id string) (map[string]any, error) {
	return queryRow(db.DB(),
		`SELECT * FROM `+tableName+` WHERE id = ? AND is_deleted = 0 LIMIT 1`, id)
}

// searchAttachments 对应 SysAttachment.search(userId, {busType, key, limit, offset})。
func searchAttachments(userID, busType, key string, limit, offset int) ([]map[string]any, error) {
	query := `SELECT * FROM ` + tableName + `
        WHERE user_id = ? AND is_deleted = 0`
	params := []any{userID}
	if busType != "" {
		query += ` AND bus_type = ?`
		params = append(params, busType)
	}
	// 关键词搜索 remark 和 tags（JSON 数组）
	if key != "" {
		query += ` AND (remark LIKE ? OR tags LIKE ? OR tags LIKE ?)`
		params = append(params, "%"+key+"%", `%"`+key+`"%`, `"`+key+`%`)
	}
	query += ` ORDER BY create_time DESC LIMIT ? OFFSET ?`
	params = append(params, limit, offset)
	return queryRows(db.DB(), query, params...)
}

// Update 对应 SysAttachment.update(id, userId, {remark, tags})。
// remark/tags 为 nil 表示 Node 的 undefined（不更新该字段）。
func Update(id, userID string, remark, tags any) (int, error) {
	var fields []string
	var params []any
	if remark != nil {
		fields = append(fields, "remark = ?")
		params = append(params, remark)
	}
	if tags != nil {
		fields = append(fields, "tags = ?")
		params = append(params, jsonStringifyTags(tags))
	}
	if len(fields) == 0 {
		return 400, nil
	}
	params = append(params, id, userID)
	n, err := execAffected(db.DB(),
		"UPDATE "+tableName+" SET "+joinFields(fields)+" WHERE id = ? AND user_id = ? AND is_deleted = 0",
		params...)
	if err != nil {
		return 500, err
	}
	if n == 0 {
		return 404, nil
	}
	return 200, nil
}

// batchDeleteRows 对应 SysAttachment.batchDelete(ids, userId)（硬删除）。
func batchDeleteRows(ids []string, userID string) (int64, error) {
	if len(ids) == 0 {
		return 0, errStatus{400, "请选择要删除的附件"}
	}
	placeholders := make([]string, len(ids))
	args := make([]any, 0, len(ids)+1)
	for i, id := range ids {
		placeholders[i] = "?"
		args = append(args, id)
	}
	args = append(args, userID)
	n, err := execAffected(db.DB(),
		"DELETE FROM "+tableName+" WHERE id IN ("+joinFields(placeholders)+") AND user_id = ?",
		args...)
	if err != nil {
		return 0, err
	}
	return n, nil
}

// IsReferencedInMoment 对应 SysAttachment.isReferencedInMoment(filePath, userId)。
// fix BUG-006：Node 版无 user_id 过滤，可探测他人附件是否存在（越权信息探测）；
// Go 版补 AND user_id = ?（调用方传入附件归属用户）。
func IsReferencedInMoment(filePath, userID string) (bool, error) {
	// 移除开头的 /，用于 JSON 匹配
	cleanPath := filePath
	if len(cleanPath) > 0 && cleanPath[0] == '/' {
		cleanPath = cleanPath[1:]
	}
	row, err := queryRow(db.DB(),
		`SELECT id FROM moment
        WHERE is_deleted = 0 AND img_url LIKE ? AND user_id = ?
        LIMIT 1`,
		"%"+cleanPath+"%", userID)
	if err != nil {
		// Node catch：检查失败返回 false（不影响删除流程）
		return false, nil
	}
	return row != nil, nil
}

// CheckReferencesResult 对应 checkReferencesBeforeDelete 返回值。
type CheckReferencesResult struct {
	ReferencedIDs []string
	SafeIDs       []string
}

// CheckReferencesBeforeDelete 对应 SysAttachment.checkReferencesBeforeDelete(ids)。
func CheckReferencesBeforeDelete(ids []string) (CheckReferencesResult, error) {
	result := CheckReferencesResult{ReferencedIDs: []string{}, SafeIDs: []string{}}
	for _, id := range ids {
		attachment, err := FindById(id)
		if err != nil {
			return result, err
		}
		if attachment != nil {
			referenced, err := IsReferencedInMoment(toStr(attachment["file_path"]), toStr(attachment["user_id"]))
			if err != nil {
				return result, err
			}
			if referenced {
				result.ReferencedIDs = append(result.ReferencedIDs, id)
			} else {
				result.SafeIDs = append(result.SafeIDs, id)
			}
		}
	}
	return result, nil
}

// errStatus 带 HTTP 状态语义的业务错误（对应 Node {status, message} 返回）。
type errStatus struct {
	status  int
	message string
}

func (e errStatus) Error() string { return e.message }
