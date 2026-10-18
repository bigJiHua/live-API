// Package db 复刻 src/common/config/db.js 的 mysql2 连接池。
package db

import (
	"database/sql"
	"fmt"
	"os"
	"sync"
	"time"

	_ "github.com/go-sql-driver/mysql" // mysql2 → go-sql-driver
)

var (
	pool *sql.DB
	once sync.Once
)

func dsn() string {
	return fmt.Sprintf("%s:%s@tcp(%s:%s)/%s?parseTime=true&loc=Local&charset=utf8mb4&multiStatements=false&interpolateParams=true",
		envOr("DB_USER", "root"), envOr("DB_PASSWORD", ""),
		envOr("DB_HOST", "localhost"), envOr("DB_PORT", "3306"),
		envOr("DB_NAME", "live"),
	)
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

// InitPool 惰性初始化连接池：connectionLimit=10、keepAlive、不限排队。
func InitPool() (*sql.DB, error) {
	var err error
	once.Do(func() {
		p, e := sql.Open("mysql", dsn())
		if e != nil {
			err = e
			return
		}
		p.SetMaxOpenConns(10)
		p.SetMaxIdleConns(10)
		p.SetConnMaxLifetime(0)
		if e = p.Ping(); e != nil {
			err = e
			return
		}
		pool = p
	})
	if err != nil {
		return nil, err
	}
	return pool, nil
}

// GetPool 返回连接池（未初始化时panic，对应 Node 未初始化即用）。
func GetPool() *sql.DB {
	if pool == nil {
		p, err := InitPool()
		if err != nil {
			panic("db pool init failed: " + err.Error())
		}
		return p
	}
	return pool
}

// Committer 抽象 *sql.DB / *sql.Tx，对应 Node 的 executor 参数。
type Committer interface {
	Exec(query string, args ...any) (sql.Result, error)
	Query(query string, args ...any) (*sql.Rows, error)
	QueryRow(query string, args ...any) *sql.Row
}

// Commiter 为 Committer 的别名（移植任务契约为 db.Commiter 拼写，两种写法等价）。
type Commiter = Committer

// DB 返回默认执行器（连接池）。
func DB() Committer { return GetPool() }

// Ping 探测连接。
func Ping() error { return GetPool().Ping() }

// Now 供日志使用。
func Now() time.Time { return time.Now() }
