package datamgr

import (
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"sync"
	"time"

	"live/api/internal/db"
)

// ============================================================================
// 备份/导出异步任务管理器 —— from: service/exportTask.js
// 所有备份导出操作均为异步，立即返回 taskId；同一类型任务同时只允许一个执行。
// ============================================================================

// 任务状态（对应 TASK_STATUS）。
const (
	taskPending   = "pending"
	taskRunning   = "running"
	taskCompleted = "completed"
	taskFailed    = "failed"
	taskCancelled = "cancelled"
)

// taskResult 对应 task.result。
type taskResult struct {
	Filename   string
	Filepath   string
	Size       int64
	Date       string
	Type       string
	Full       map[string]any // system backup 的 full 结果
	SchemaOnly map[string]any // system backup 的 schema-only 结果
	RowCount   any
}

// exportTask 对应任务对象。
type exportTask struct {
	ID          string
	Type        string // export_table / export_full_database / system_backup
	TableName   string
	TableSize   any
	Status      string
	Progress    int
	Options     map[string]any
	TableSizes  []map[string]any
	CreatedAt   time.Time
	StartedAt   *time.Time
	CompletedAt *time.Time
	Error       string
	Result      *taskResult
}

// taskView 对应 controller 返回给前端的 task 视图。
type taskView struct {
	ID          string         `json:"id"`
	Type        string         `json:"type"`
	Status      string         `json:"status"`
	TableName   string         `json:"tableName"`
	TableSize   any            `json:"tableSize"`
	Progress    int            `json:"progress"`
	Error       string         `json:"error"`
	Result      map[string]any `json:"result"`
	CreatedAt   string         `json:"createdAt"`
	StartedAt   string         `json:"startedAt"`
	CompletedAt string         `json:"completedAt"`
}

func (t *exportTask) toView() taskView {
	v := taskView{
		ID: t.ID, Type: t.Type, Status: t.Status, TableName: t.TableName,
		TableSize: t.TableSize, Progress: t.Progress, Error: t.Error,
	}
	if t.Result != nil {
		v.Result = map[string]any{
			"filename":   t.Result.Filename,
			"full":       t.Result.Full,
			"schemaOnly": t.Result.SchemaOnly,
			"size":       t.Result.Size,
			"date":       t.Result.Date,
		}
	}
	v.CreatedAt = isoTime(t.CreatedAt)
	v.StartedAt = isoTimePtr(t.StartedAt)
	v.CompletedAt = isoTimePtr(t.CompletedAt)
	return v
}

func isoTime(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z") }
func isoTimePtr(t *time.Time) string {
	if t == nil {
		return ""
	}
	return isoTime(*t)
}

var (
	taskMu sync.Mutex
	tasks  = map[string]*exportTask{}
)

// generateTaskId 对应 generateTaskId()：task_YYYYMMDDHHmmss_rand6。
func generateTaskId() string {
	return "task_" + time.Now().Format("20060102150405") + "_" + rand6()
}

// analyzeTableSize 对应 analyzeTableSize(tableName)。
// fix BUG-005：Node 版直接拼接表名（SELECT COUNT(*) FROM `${tableName}`）未过白名单，
// 存在管理员后台 SQL 注入；Go 版统一走 safeTableName 白名单。
func analyzeTableSize(tableName string) (any, error) {
	safe, err := safeTableName(tableName)
	if err != nil {
		return nil, err
	}
	row, err := queryRow(db.DB(), "SELECT COUNT(*) as count FROM `"+safe+"`")
	if err != nil {
		return nil, err
	}
	if row == nil {
		return 0, nil
	}
	return orZero(row["count"]), nil
}

// getRunningTask 对应 getRunningTask(type)：返回同类型 pending/running 任务。
func getRunningTask(typ string) *exportTask {
	taskMu.Lock()
	defer taskMu.Unlock()
	for _, t := range tasks {
		if t.Type == typ && (t.Status == taskPending || t.Status == taskRunning) {
			return t
		}
	}
	return nil
}

// createExportTask 对应 createExportTask(tableName, options)。
func createExportTask(tableName string, options map[string]any) (*exportTask, error) {
	tableSize, err := analyzeTableSize(tableName)
	if err != nil {
		return nil, err
	}
	task := &exportTask{
		ID:        generateTaskId(),
		Type:      "export_table",
		TableName: tableName,
		TableSize: tableSize,
		Status:    taskPending,
		Progress:  0,
		Options:   options,
		CreatedAt: time.Now(),
	}
	taskMu.Lock()
	tasks[task.ID] = task
	taskMu.Unlock()
	// 始终异步执行（对应 setImmediate）
	go executeExportTableTask(task.ID)
	return task, nil
}

func setTaskState(t *exportTask, status string, progress int) {
	taskMu.Lock()
	t.Status = status
	t.Progress = progress
	taskMu.Unlock()
}

func executeExportTableTask(taskID string) {
	taskMu.Lock()
	task := tasks[taskID]
	if task == nil {
		taskMu.Unlock()
		return
	}
	now := time.Now()
	task.Status = taskRunning
	task.StartedAt = &now
	task.Progress = 5
	taskMu.Unlock()

	includeData := true
	if v, ok := task.Options["includeData"]; ok {
		if b, ok := v.(bool); ok {
			includeData = b
		}
	}
	sqlFilename := stampNow() + "-" + task.TableName + ".sql"
	sqlFilepath := filepath.Join(getBackupDir(), sqlFilename)
	zipFilename := stampNow() + "-" + task.TableName + ".sql.zip"
	zipFilepath := filepath.Join(getBackupDir(), zipFilename)

	setTaskState(task, taskRunning, 15)
	if err := runMysqldump(sqlFilepath, task.TableName, includeData); err != nil {
		failTask(task, err)
		return
	}

	// 取消检查（dump 后）
	taskMu.Lock()
	cancelled := task.Status == taskCancelled
	taskMu.Unlock()
	if cancelled {
		_ = removeIfExists(sqlFilepath)
		return
	}

	setTaskState(task, taskRunning, 70)
	if _, err := zipSingleFile(sqlFilepath, sqlFilename, zipFilepath, 6); err != nil {
		_ = removeIfExists(sqlFilepath)
		failTask(task, err)
		return
	}
	_ = removeIfExists(sqlFilepath)

	st, err := statSize(zipFilepath)
	if err != nil {
		failTask(task, err)
		return
	}
	taskMu.Lock()
	task.Status = taskCompleted
	task.Progress = 100
	done := time.Now()
	task.CompletedAt = &done
	task.Result = &taskResult{
		Filename: zipFilename, Filepath: zipFilepath, Size: st, RowCount: task.TableSize,
	}
	taskMu.Unlock()
}

// createFullExportTask 对应 createFullExportTask(options)。
func createFullExportTask(options map[string]any) (*exportTask, error) {
	tableNames, err := getTableList()
	if err != nil {
		return nil, err
	}
	var tableSizes []map[string]any
	totalSize := 0
	for _, tableName := range tableNames {
		count, err := analyzeTableSize(tableName)
		if err != nil {
			return nil, err
		}
		n := toInt(count)
		tableSizes = append(tableSizes, map[string]any{"name": tableName, "rows": count})
		totalSize += n
	}

	task := &exportTask{
		ID:         generateTaskId(),
		Type:       "export_full_database",
		TableSize:  totalSize,
		Status:     taskPending,
		Progress:   0,
		Options:    options,
		TableSizes: tableSizes,
		CreatedAt:  time.Now(),
	}
	taskMu.Lock()
	tasks[task.ID] = task
	taskMu.Unlock()
	go executeFullExportTask(task.ID)
	return task, nil
}

func executeFullExportTask(taskID string) {
	taskMu.Lock()
	task := tasks[taskID]
	if task == nil {
		taskMu.Unlock()
		return
	}
	now := time.Now()
	task.Status = taskRunning
	task.StartedAt = &now
	task.Progress = 5
	taskMu.Unlock()

	includeData := true
	if v, ok := task.Options["includeData"]; ok {
		if b, ok := v.(bool); ok {
			includeData = b
		}
	}
	timestamp := stampNow()

	// executeFullExportToZip
	sqlFilename := timestamp + "-full-backup.sql"
	sqlFilepath := filepath.Join(getBackupDir(), sqlFilename)
	zipFilename := timestamp + "-full-backup.sql.zip"
	zipFilepath := filepath.Join(getBackupDir(), zipFilename)

	setTaskState(task, taskRunning, 10)
	if err := runMysqldump(sqlFilepath, "", includeData); err != nil {
		failTask(task, err)
		return
	}

	taskMu.Lock()
	cancelled := task.Status == taskCancelled
	taskMu.Unlock()
	if cancelled {
		_ = removeIfExists(sqlFilepath)
		return
	}

	setTaskState(task, taskRunning, 70)
	if _, err := zipSingleFile(sqlFilepath, sqlFilename, zipFilepath, 6); err != nil {
		_ = removeIfExists(sqlFilepath)
		failTask(task, err)
		return
	}
	_ = removeIfExists(sqlFilepath)

	st, err := statSize(zipFilepath)
	if err != nil {
		failTask(task, err)
		return
	}
	taskMu.Lock()
	task.Status = taskCompleted
	task.Progress = 100
	done := time.Now()
	task.CompletedAt = &done
	task.Result = &taskResult{
		Filename: zipFilename, Filepath: zipFilepath, Size: st, RowCount: task.TableSize,
	}
	taskMu.Unlock()
}

// createSystemBackupTask 对应 createSystemBackupTask(options)。
func createSystemBackupTask(options map[string]any) *exportTask {
	task := &exportTask{
		ID:        generateTaskId(),
		Type:      "system_backup",
		Status:    taskPending,
		Progress:  0,
		Options:   options,
		CreatedAt: time.Now(),
	}
	taskMu.Lock()
	tasks[task.ID] = task
	taskMu.Unlock()
	go executeSystemBackupTask(task.ID)
	return task
}

func executeSystemBackupTask(taskID string) {
	taskMu.Lock()
	task := tasks[taskID]
	if task == nil {
		taskMu.Unlock()
		return
	}
	now := time.Now()
	task.Status = taskRunning
	task.StartedAt = &now
	task.Progress = 5
	taskMu.Unlock()

	dateStr := time.Now().Format("2006-01-02")
	backupDir := getDateBackupDir(dateStr)

	// 检查当日备份上限（对应 existingFiles.length / 2 >= 3）
	entries, err := readSQLFiles(backupDir)
	if err != nil {
		failTask(task, err)
		return
	}
	if len(entries)/2 >= 3 {
		taskMu.Lock()
		task.Status = taskFailed
		task.Error = "今日备份已达上限（3次）"
		done := time.Now()
		task.CompletedAt = &done
		taskMu.Unlock()
		return
	}

	// 系统备份固定产出：完整备份（runMysqldump includeData=true）+ 仅结构备份（false）
	timestamp := stampNow()

	// 完整备份
	setTaskState(task, taskRunning, 10)
	fullFilename := timestamp + "-system-backup-full.sql"
	fullFilepath := filepath.Join(backupDir, fullFilename)
	if err := runMysqldump(fullFilepath, "", true); err != nil {
		_ = removeIfExists(fullFilepath)
		failTask(task, err)
		return
	}
	taskMu.Lock()
	cancelled := task.Status == taskCancelled
	taskMu.Unlock()
	if cancelled {
		_ = removeIfExists(fullFilepath)
		return
	}
	fullStats, err := statSize(fullFilepath)
	if err != nil {
		failTask(task, err)
		return
	}

	// 仅结构备份
	setTaskState(task, taskRunning, 55)
	schemaFilename := timestamp + "-system-backup-schema-only.sql"
	schemaFilepath := filepath.Join(backupDir, schemaFilename)
	if err := runMysqldump(schemaFilepath, "", false); err != nil {
		_ = removeIfExists(fullFilepath)
		_ = removeIfExists(schemaFilepath)
		failTask(task, err)
		return
	}
	taskMu.Lock()
	cancelled = task.Status == taskCancelled
	taskMu.Unlock()
	if cancelled {
		_ = removeIfExists(schemaFilepath)
		return
	}
	schemaStats, err := statSize(schemaFilepath)
	if err != nil {
		_ = removeIfExists(fullFilepath)
		failTask(task, err)
		return
	}

	taskMu.Lock()
	task.Status = taskCompleted
	task.Progress = 100
	done := time.Now()
	task.CompletedAt = &done
	task.Result = &taskResult{
		Date:       dateStr,
		Full:       map[string]any{"filename": fullFilename, "filepath": fullFilepath, "size": fullStats, "date": dateStr, "type": "full"},
		SchemaOnly: map[string]any{"filename": schemaFilename, "filepath": schemaFilepath, "size": schemaStats, "date": dateStr, "type": "schema-only"},
	}
	taskMu.Unlock()
}

func failTask(task *exportTask, err error) {
	taskMu.Lock()
	task.Status = taskFailed
	task.Error = err.Error()
	done := time.Now()
	task.CompletedAt = &done
	taskMu.Unlock()
}

// getTaskStatus 对应 getTaskStatus(taskId)。
func getTaskStatus(taskID string) *exportTask {
	taskMu.Lock()
	defer taskMu.Unlock()
	return tasks[taskID]
}

// cancelTask 对应 cancelTask(taskId)。
func cancelTask(taskID string) bool {
	taskMu.Lock()
	defer taskMu.Unlock()
	task := tasks[taskID]
	if task == nil {
		return false
	}
	if task.Status == taskPending || task.Status == taskRunning {
		task.Status = taskCancelled
		return true
	}
	return false
}

// getAllTasks 对应 getAllTasks()（按创建时间倒序）。
func getAllTasks() []*exportTask {
	taskMu.Lock()
	defer taskMu.Unlock()
	out := make([]*exportTask, 0, len(tasks))
	for _, t := range tasks {
		out = append(out, t)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.After(out[j].CreatedAt) })
	return out
}

// cleanupOldTasks 对应 cleanupOldTasks(maxAgeMs=24h)。
func cleanupOldTasks(maxAge time.Duration) {
	now := time.Now()
	taskMu.Lock()
	defer taskMu.Unlock()
	for id, t := range tasks {
		if now.Sub(t.CreatedAt) > maxAge && t.Status != taskRunning {
			delete(tasks, id)
		}
	}
}

// ===== 小助手 =====

func removeIfExists(p string) error {
	if fileExists(p) {
		return os.Remove(p)
	}
	return nil
}

func statSize(p string) (int64, error) {
	st, err := os.Stat(p)
	if err != nil {
		return 0, err
	}
	return st.Size(), nil
}

func readSQLFiles(dir string) ([]string, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	var out []string
	for _, e := range entries {
		name := e.Name()
		if len(name) > 4 && name[len(name)-4:] == ".sql" {
			out = append(out, name)
		}
	}
	return out, nil
}

func toInt(v any) int {
	switch t := v.(type) {
	case int:
		return t
	case int64:
		return int(t)
	case float64:
		return int(t)
	case string:
		n, _ := strconv.Atoi(t)
		return n
	}
	return 0
}
