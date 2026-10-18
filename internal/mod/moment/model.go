// Package moment 复刻 src/modules/moment（动态日记：api + controller + model）。
// SQL 逐字一致（? 占位）；keep/fix 标注同 build_logs/api.logs：
//   - keep BUG-029：findTodayMain + create 无事务无唯一约束，同日并发可产生多个主动态，维持原样；
//   - keep BUG-030：delete 多步非原子（5 条 UPDATE 无事务），维持原样；
//   - fix BUG-008：分享密码 genPw 由 Math.random 改为 sec.Digits6（密码学随机）。
package moment

import (
	"strconv"
	"strings"
	"time"

	"live/api/internal/db"
	"live/api/internal/idgen"
	"live/api/internal/tim"
)

// ===== 行 → map 工具（与 cardbill 包各自的私有副本，避免共享导出面） =====

// qRow 查询单行并转为 map（列名 → 值）；无记录返回 nil, nil。
func qRow(ex db.Commiter, q string, args ...any) (map[string]any, error) {
	rows, err := ex.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	cols, err := rows.Columns()
	if err != nil {
		return nil, err
	}
	if !rows.Next() {
		return nil, rows.Err()
	}
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
	return m, rows.Err()
}

// qRows 查询多行并转为 []map。
func qRows(ex db.Commiter, q string, args ...any) ([]map[string]any, error) {
	rows, err := ex.Query(q, args...)
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

// normVal DB 值 → JSON 友好值：[]byte→string（mysql2 DECIMAL/CHAR 返回串）；其余原样。
func normVal(v any) any {
	if b, ok := v.([]byte); ok {
		return string(b)
	}
	return v
}

// execAffected Exec 并返回 affectedRows。
func execAffected(ex db.Commiter, q string, args ...any) (int64, error) {
	res, err := ex.Exec(q, args...)
	if err != nil {
		return 0, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return 0, err
	}
	return n, nil
}

// ===== 本地时间工具（对应 model/index.js 的 new Date() 本地时区语义） =====

// dayStartMS 当天 00:00:00.000 本地毫秒串（对应 start.setHours(0,0,0,0)）。
func dayStartMS() string {
	now := tim.Now()
	start := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, tim.Loc())
	return msString(start)
}

// dayEndMS 当天 23:59:59.999 本地毫秒串（对应 end.setHours(23,59,59,999)）。
func dayEndMS() string {
	now := tim.Now()
	start := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, tim.Loc())
	return msString(start.Add(24*time.Hour - time.Millisecond))
}

// msString 毫秒时间戳字符串（对应 Date#getTime().toString()）。
func msString(t time.Time) string {
	return strconv.FormatInt(t.UnixMilli(), 10)
}

// ===== Model 方法（复刻 model/index.js） =====

// Create 对应 Moment.create。
// parentId 为空表示今日第一条（父亲，parent_id = id 指向自己）；有值表示追加，parent_id = parentId。
// imgURL/mood/location/visibleType 传 nil 表示 SQL NULL（对应 JS null）；调用方已完成 JSON.stringify。
// from: moment/model/index.js:11-45
func momentCreate(ex db.Commiter, userID, parentID string, content any, imgURL, mood, location, visibleType any) (string, error) {
	id := idgen.NanoID(21) // 对应 nanoid()（默认 21 位）
	now := tim.NowMS()

	// 如果是今日第一条（parentId = null），parent_id = id（指向自己）
	finalParentID := parentID
	if finalParentID == "" {
		finalParentID = id
	}

	_, err := ex.Exec(`
      INSERT INTO moment 
      (id, user_id, parent_id, content, img_url, mood, location, visible_type, create_time, update_time, is_deleted) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
		id, userID, finalParentID, content, imgURL, mood, location, visibleType, now, now)
	if err != nil {
		return "", err
	}
	return id, nil
}

// FindTodayMain 查找用户今天的第一条主动态（用于聚合）。主动态：parent_id = id。
// keep BUG-029：findTodayMain 无事务/无唯一约束，"今天"按服务器本地时区，维持原样。
// from: moment/model/index.js:52-70
func findTodayMain(ex db.Commiter, userID string) (map[string]any, error) {
	return qRow(ex, `
      SELECT id FROM moment 
      WHERE user_id = ? 
        AND parent_id = id 
        AND create_time BETWEEN ? AND ? 
        AND is_deleted = 0 
      LIMIT 1`, userID, dayStartMS(), dayEndMS())
}

// FindByUser 分页列表：主动态列表（parent_id = id）+ 子动态 id 数组（GROUP_CONCAT）。
// from: moment/model/index.js:76-109
func findByUser(ex db.Commiter, userID string, page, pageSize float64) ([]map[string]any, int64, error) {
	offset := (page - 1) * pageSize

	list, err := qRows(ex, `
      SELECT m.*, 
      (SELECT GROUP_CONCAT(id ORDER BY create_time ASC) 
       FROM moment 
       WHERE parent_id = m.id AND id != m.id AND is_deleted = 0) as children
      FROM moment m
      WHERE m.user_id = ? 
        AND m.parent_id = m.id 
        AND m.is_deleted = 0
      ORDER BY m.create_time DESC 
      LIMIT ? OFFSET ?`, userID, numParam(pageSize), numParam(offset))
	if err != nil {
		return nil, 0, err
	}

	cnt, err := qRow(ex, `
      SELECT COUNT(*) as total FROM moment 
      WHERE user_id = ? 
        AND parent_id = id 
        AND is_deleted = 0`, userID)
	if err != nil {
		return nil, 0, err
	}
	total := int64(0)
	switch t := cnt["total"].(type) {
	case int64:
		total = t
	case float64:
		total = int64(t)
	}
	return list, total, nil
}

// FindTodayWithChildren 今日动态（含所有子动态）。
// from: moment/model/index.js:116-155
func findTodayWithChildren(ex db.Commiter, userID string) ([]map[string]any, error) {
	rows, err := qRows(ex, `
      SELECT m.*, 
      (SELECT GROUP_CONCAT(id ORDER BY create_time ASC) 
       FROM moment 
       WHERE parent_id = m.id AND id != m.id AND is_deleted = 0) as children
      FROM moment m
      WHERE m.user_id = ? AND m.is_deleted = 0 AND m.create_time >= ?
      ORDER BY m.create_time ASC`, userID, dayStartMS())
	if err != nil {
		return nil, err
	}

	// 分离父级和子级：parent_id = id 的是主动态
	result := []map[string]any{}
	childrenMap := map[string][]map[string]any{}
	for _, item := range rows {
		if toStr(item["parent_id"]) == toStr(item["id"]) {
			result = append(result, mergeKV(item, map[string]any{"children_data": []map[string]any{}}))
		} else {
			p := toStr(item["parent_id"])
			childrenMap[p] = append(childrenMap[p], item)
		}
	}
	// 挂载子动态
	for _, item := range result {
		if kids, ok := childrenMap[toStr(item["id"])]; ok {
			item["children_data"] = kids
		}
	}
	return result, nil
}

// FindById 单条查询。from: moment/model/index.js:161-171
func findById(ex db.Commiter, id string) (map[string]any, error) {
	return qRow(ex, `
      SELECT m.*, 
      (SELECT GROUP_CONCAT(id ORDER BY create_time ASC) 
       FROM moment 
       WHERE parent_id = m.id AND id != m.id AND is_deleted = 0) as children
      FROM moment m 
      WHERE m.id = ? AND m.is_deleted = 0`, id)
}

// FindByIds 批量查询。from: moment/model/index.js:177-186
func findByIds(ex db.Commiter, ids []any, userID string) ([]map[string]any, error) {
	if len(ids) == 0 {
		return []map[string]any{}, nil
	}
	ph := strings.Repeat("?,", len(ids))
	ph = ph[:len(ph)-1]
	params := append(append([]any{}, ids...), userID)
	return qRows(ex, `
      SELECT * FROM moment 
      WHERE id IN (`+ph+`) AND user_id = ? AND is_deleted = 0
      ORDER BY create_time ASC`, params...)
}

// Update 更新动态；返回 {status, message}。
// 注意：updates 采用「键存在即更新」语义（对应 Node 的 updates.xxx !== undefined，
// 显式 null 会写入 SQL NULL）；控制器保证 JSON.stringify 在调用前完成。
// from: moment/model/index.js:192-231
func update(ex db.Commiter, id, userID string, updates map[string]any) map[string]any {
	fields := []string{}
	values := []any{}

	if v, ok := updates["content"]; ok {
		fields = append(fields, "content = ?")
		values = append(values, v)
	}
	if v, ok := updates["imgUrl"]; ok {
		fields = append(fields, "img_url = ?")
		values = append(values, v)
	}
	if v, ok := updates["mood"]; ok {
		fields = append(fields, "mood = ?")
		values = append(values, v)
	}
	if v, ok := updates["location"]; ok {
		fields = append(fields, "location = ?")
		values = append(values, v)
	}
	if v, ok := updates["visibleType"]; ok {
		fields = append(fields, "visible_type = ?")
		values = append(values, v)
	}

	if len(fields) == 0 {
		return map[string]any{"status": 200, "message": "无更新内容"}
	}

	fields = append(fields, "update_time = ?")
	values = append(values, tim.NowMS())
	values = append(values, id, userID)

	n, err := execAffected(ex,
		"UPDATE moment SET "+strings.Join(fields, ", ")+" WHERE id = ? AND user_id = ? AND is_deleted = 0",
		values...)
	if err != nil {
		return map[string]any{"status": 500, "message": "更新失败"}
	}
	if n == 0 {
		return map[string]any{"status": 404, "message": "动态不存在或无权修改"}
	}
	return map[string]any{"status": 200, "message": "更新成功"}
}

// Delete 删除动态（软删除 + 父动态重绑定）。
// keep BUG-030：5 条 UPDATE 无事务，中途失败留下孤儿子动态，维持原样。
// from: moment/model/index.js:240-315
func delete(ex db.Commiter, id, userID string) map[string]any {
	// 1️⃣ 查当前动态
	m, err := qRow(ex, `SELECT id, parent_id
     FROM moment
     WHERE id = ? AND user_id = ? AND is_deleted = 0
     LIMIT 1`, id, userID)
	if err != nil {
		return map[string]any{"status": 500, "message": "删除失败"}
	}
	if m == nil {
		return map[string]any{"status": 404, "message": "动态不存在或无权删除"}
	}

	now := tim.NowMS()

	// 2️⃣ 判断是否父（自引用）
	isParent := toStr(m["id"]) == toStr(m["parent_id"])

	// =========================
	// ✅ 子动态：直接删
	// =========================
	if !isParent {
		if _, err := ex.Exec(
			`UPDATE moment SET is_deleted = 1, update_time = ? WHERE id = ?`,
			[]any{now, id}...); err != nil {
			return map[string]any{"status": 500, "message": "删除失败"}
		}
		return map[string]any{"status": 200, "message": "删除成功"}
	}

	// =========================
	// ✅ 父动态：重建结构
	// =========================

	// 3️⃣ 找所有子（只靠 parent_id）
	children, err := qRows(ex, `SELECT id
     FROM moment
     WHERE parent_id = ?
       AND id != parent_id
       AND user_id = ?
       AND is_deleted = 0
     ORDER BY create_time ASC`, id, userID)
	if err != nil {
		return map[string]any{"status": 500, "message": "删除失败"}
	}

	if len(children) > 0 {
		newParentID := toStr(children[0]["id"])

		// 4️⃣ 子1 → 升级为父（自己指向自己）
		if _, err := ex.Exec(
			`UPDATE moment SET parent_id = id, update_time = ? WHERE id = ?`,
			now, newParentID); err != nil {
			return map[string]any{"status": 500, "message": "删除失败"}
		}

		// 5️⃣ 其他子 → 全部挂到新父
		if _, err := ex.Exec(
			`UPDATE moment
       SET parent_id = ?, update_time = ?
       WHERE parent_id = ?
         AND id != ?
         AND id != parent_id`,
			newParentID, now, id, newParentID); err != nil {
			return map[string]any{"status": 500, "message": "删除失败"}
		}
	}

	// 6️⃣ 删除旧父
	if _, err := ex.Exec(
		`UPDATE moment SET is_deleted = 1, update_time = ? WHERE id = ?`,
		now, id); err != nil {
		return map[string]any{"status": 500, "message": "删除失败"}
	}

	return map[string]any{"status": 200, "message": "删除成功"}
}

// ===== 通用值转换 =====

func toStr(v any) string {
	switch t := v.(type) {
	case nil:
		return ""
	case string:
		return t
	case int64:
		return strconv.FormatInt(t, 10)
	case float64:
		return strconv.FormatFloat(t, 'f', -1, 64)
	}
	return ""
}

// numParam 数值 SQL 参数：NaN → "NaN" 字符串（与 Node mysql2 发送 NaN 同样触发 SQL 错误路径）。
func numParam(f float64) any {
	if isNaN(f) {
		return "NaN"
	}
	if f == float64(int64(f)) {
		return int64(f)
	}
	return f
}

func isNaN(f float64) bool { return f != f }

// mergeKV 返回 m 的副本并叠加 kv（对应 JS {...item, children_data: []}）。
func mergeKV(m map[string]any, kv map[string]any) map[string]any {
	out := make(map[string]any, len(m)+len(kv))
	for k, v := range m {
		out[k] = v
	}
	for k, v := range kv {
		out[k] = v
	}
	return out
}
