package polaris

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
	_ "modernc.org/sqlite"
)

type Object map[string]any

type Store struct {
	db       *sql.DB
	postgres bool
	mu       sync.Mutex
	queries  atomic.Uint64
}

type databaseOpenError struct { connection bool }

func (e *databaseOpenError) Error() string { return "database unavailable" }

type transaction struct {
	store *Store
	tx    *sql.Tx
}

func OpenStore(ctx context.Context, databaseURL string) (*Store, error) {
	return openStore(ctx, databaseURL, false)
}

func openStore(ctx context.Context, databaseURL string, newPostgres bool) (*Store, error) {
	pg := strings.HasPrefix(databaseURL, "postgres://") || strings.HasPrefix(databaseURL, "postgresql://")
	driver := "sqlite"
	if pg {
		driver = "pgx"
	} else {
		separator := "?"
		if strings.Contains(databaseURL, "?") {
			separator = "&"
		}
		databaseURL += separator + "_pragma=busy_timeout(10000)&_pragma=journal_mode(WAL)&_pragma=foreign_keys(1)"
	}
	db, err := sql.Open(driver, databaseURL)
	if err != nil {
		return nil, &databaseOpenError{connection: true}
	}
	if !pg {
		db.SetMaxOpenConns(1)
	} else {
		db.SetMaxOpenConns(12)
	}
	s := &Store{db: db, postgres: pg}
	if err = db.PingContext(ctx); err != nil {
		db.Close()
		return nil, &databaseOpenError{connection: true}
	}
	var executor interface { ExecContext(context.Context, string, ...any) (sql.Result, error) } = db
	var schemaTx *sql.Tx
	if newPostgres && pg {
		schemaTx, err = db.BeginTx(ctx, nil)
		if err != nil { db.Close(); return nil, &databaseOpenError{} }
		defer schemaTx.Rollback()
		if _, err = schemaTx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(751425306)`); err != nil {
			schemaTx.Rollback(); db.Close(); return nil, &databaseOpenError{}
		}
		if err = validateEmptyPostgres(ctx, schemaTx, false); err != nil {
			schemaTx.Rollback(); db.Close(); return nil, &databaseOpenError{}
		}
		executor = schemaTx
	}
	seq := "INTEGER PRIMARY KEY AUTOINCREMENT"
	if pg {
		seq = "BIGSERIAL PRIMARY KEY"
	}
	for _, stmt := range []string{
		`CREATE TABLE IF NOT EXISTS polaris_documents(kind TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,updated_at BIGINT NOT NULL,PRIMARY KEY(kind,id))`,
		`CREATE TABLE IF NOT EXISTS polaris_readings(seq ` + seq + `,monitor_id TEXT NOT NULL,ts BIGINT NOT NULL,status INTEGER NOT NULL,value DOUBLE PRECISION,code INTEGER NOT NULL,message TEXT NOT NULL,addons TEXT NOT NULL)`,
		`CREATE INDEX IF NOT EXISTS polaris_readings_monitor_time ON polaris_readings(monitor_id,ts)`,
		`CREATE INDEX IF NOT EXISTS polaris_readings_time ON polaris_readings(ts)`,
		`CREATE TABLE IF NOT EXISTS polaris_leases(id TEXT PRIMARY KEY,owner TEXT NOT NULL,expires_at BIGINT NOT NULL,next_due BIGINT NOT NULL)`,
		`CREATE TABLE IF NOT EXISTS polaris_sequences(name TEXT PRIMARY KEY,value BIGINT NOT NULL)`,
	} {
		if _, err = executor.ExecContext(ctx, stmt); err != nil {
			if schemaTx != nil { schemaTx.Rollback() }
			db.Close()
			return nil, &databaseOpenError{}
		}
	}
	for _, field := range []string{"agent_id", "monitor_id"} {
		stmt := `CREATE INDEX IF NOT EXISTS polaris_documents_` + field + `_state ON polaris_documents(kind,` + s.jsonField(field) + `,` + s.jsonField("state") + `)`
		if _, err = executor.ExecContext(ctx, stmt); err != nil {
			if schemaTx != nil { schemaTx.Rollback() }
			db.Close()
			return nil, &databaseOpenError{}
		}
	}
	for _, field := range []string{"scheduled_at", "queued_at"} {
		stmt := `CREATE INDEX IF NOT EXISTS polaris_documents_` + field + `_time ON polaris_documents(kind,CAST(COALESCE(` + s.jsonField(field) + `,'0') AS BIGINT))`
		if _, err = executor.ExecContext(ctx, stmt); err != nil {
			if schemaTx != nil { schemaTx.Rollback() }
			db.Close()
			return nil, &databaseOpenError{}
		}
	}
	if schemaTx != nil {
		if err = schemaTx.Commit(); err != nil { db.Close(); return nil, &databaseOpenError{} }
	}
	return s, nil
}

func (s *Store) jsonField(field string) string {
	if s.postgres {
		return `(data::jsonb->>'` + field + `')`
	}
	return `json_extract(data,'$.` + field + `')`
}

type documentQueryer interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}

func (s *Store) queueDocuments(ctx context.Context, db documentQueryer, kind, field, id string, completed bool, version string, limit int) ([]Object, error) {
	where := `(` + s.jsonField("state") + `='pending' OR (` + s.jsonField("state") + `='leased' AND CAST(COALESCE(` + s.jsonField("lease_until") + `,'0') AS BIGINT)<=` + fmt.Sprint(time.Now().Unix()) + `))`
	order := s.jsonField("scheduled_at")
	if kind == "command" {
		order = s.jsonField("queued_at")
	}
	if completed {
		where = s.jsonField("state") + `='completed' AND COALESCE(CAST(` + s.jsonField("consumed") + ` AS TEXT),'false') IN ('false','0') AND ` + s.jsonField("source_version") + `=?`
		order = s.jsonField("observed_at") + ` DESC`
	}
	query := `SELECT data FROM polaris_documents WHERE kind=? AND ` + s.jsonField(field) + `=? AND ` + where + ` ORDER BY ` + order + `,id LIMIT ?`
	args := []any{kind, id}
	if completed {
		args = append(args, version)
	}
	args = append(args, limit)
	rows, err := db.QueryContext(ctx, s.query(query), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Object{}
	for rows.Next() {
		var raw string
		if err = rows.Scan(&raw); err != nil {
			return nil, err
		}
		o, e := decodeObject(raw)
		if e != nil {
			return nil, e
		}
		out = append(out, o)
	}
	return out, rows.Err()
}

func (s *Store) Close() error { return s.db.Close() }

func (s *Store) query(q string) string {
	s.queries.Add(1)
	if !s.postgres {
		return q
	}
	var out strings.Builder
	n := 0
	for _, c := range q {
		if c == '?' {
			n++
			fmt.Fprintf(&out, "$%d", n)
		} else {
			out.WriteRune(c)
		}
	}
	return out.String()
}

// 回调只能通过传入的事务访问存储；重新调用 Store 方法会争用锁或连接。
// Access storage through the supplied transaction inside the callback; Store methods can contend for the lock or connection.
func (s *Store) mutate(ctx context.Context, fn func(*transaction) error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if s.postgres {
		if _, err = tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(751425306)`); err != nil {
			return err
		}
	}
	if err = fn(&transaction{s, tx}); err != nil {
		return err
	}
	return tx.Commit()
}

func decodeObject(raw string) (Object, error) {
	var o Object
	err := json.Unmarshal([]byte(raw), &o)
	return o, err
}

func (s *Store) get(ctx context.Context, kind, id string) (Object, error) {
	var raw string
	err := s.db.QueryRowContext(ctx, s.query(`SELECT data FROM polaris_documents WHERE kind=? AND id=?`), kind, id).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return decodeObject(raw)
}

func (s *Store) list(ctx context.Context, kind string) ([]Object, error) {
	rows, err := s.db.QueryContext(ctx, s.query(`SELECT data FROM polaris_documents WHERE kind=? ORDER BY updated_at,id`), kind)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Object{}
	for rows.Next() {
		var raw string
		if err = rows.Scan(&raw); err != nil {
			return nil, err
		}
		o, e := decodeObject(raw)
		if e != nil {
			return nil, e
		}
		out = append(out, o)
	}
	return out, rows.Err()
}

func (t *transaction) get(kind, id string) (Object, error) {
	var raw string
	err := t.tx.QueryRow(t.store.query(`SELECT data FROM polaris_documents WHERE kind=? AND id=?`), kind, id).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return decodeObject(raw)
}
func (t *transaction) list(kind string) ([]Object, error) {
	rows, err := t.tx.Query(t.store.query(`SELECT data FROM polaris_documents WHERE kind=? ORDER BY updated_at,id`), kind)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Object{}
	for rows.Next() {
		var raw string
		if err = rows.Scan(&raw); err != nil {
			return nil, err
		}
		o, e := decodeObject(raw)
		if e != nil {
			return nil, e
		}
		out = append(out, o)
	}
	return out, rows.Err()
}
func (t *transaction) put(kind, id string, o Object) error {
	raw, err := json.Marshal(o)
	if err != nil {
		return err
	}
	_, err = t.tx.Exec(t.store.query(`INSERT INTO polaris_documents(kind,id,data,updated_at) VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at`), kind, id, string(raw), time.Now().Unix())
	return err
}
func (t *transaction) remove(kind, id string) error {
	_, err := t.tx.Exec(t.store.query(`DELETE FROM polaris_documents WHERE kind=? AND id=?`), kind, id)
	return err
}
func (t *transaction) next(name string) (int64, error) {
	var value int64
	err := t.tx.QueryRow(t.store.query(`INSERT INTO polaris_sequences(name,value) VALUES(?,1) ON CONFLICT(name) DO UPDATE SET value=polaris_sequences.value+1 RETURNING value`), name).Scan(&value)
	return value, err
}

func (s *Store) put(ctx context.Context, kind, id string, o Object) error {
	return s.mutate(ctx, func(t *transaction) error { return t.put(kind, id, o) })
}

// force 只绕过 next_due，不抢占仍有效的租约。
// force bypasses next_due only; it does not steal an unexpired lease.
func (s *Store) claim(ctx context.Context, id, owner string, now, ttl int64, force bool) (bool, error) {
	due := now
	if force {
		due = 1 << 62
	}
	result, err := s.db.ExecContext(ctx, s.query(`INSERT INTO polaris_leases(id,owner,expires_at,next_due) VALUES(?,?,?,0) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at WHERE polaris_leases.expires_at<=? AND polaris_leases.next_due<=?`), id, owner, now+ttl, now, due)
	if err != nil {
		return false, err
	}
	n, err := result.RowsAffected()
	return n == 1, err
}
func (s *Store) release(ctx context.Context, id, owner string, next int64) error {
	_, err := s.db.ExecContext(ctx, s.query(`UPDATE polaris_leases SET expires_at=0,next_due=? WHERE id=? AND owner=?`), next, id, owner)
	return err
}

func str(o Object, k string) string { v, _ := o[k].(string); return v }
func number(v any) float64 {
	switch n := v.(type) {
	case float64:
		return n
	case int:
		return float64(n)
	case int64:
		return float64(n)
	case json.Number:
		f, _ := n.Float64()
		return f
	}
	return 0
}
func integer(o Object, k string) int64 { return int64(number(o[k])) }
func boolean(v any) bool {
	if b, ok := v.(bool); ok {
		return b
	}
	return number(v) != 0
}
func object(v any) Object {
	if o, ok := v.(Object); ok {
		return o
	}
	if o, ok := v.(map[string]any); ok {
		return Object(o)
	}
	return nil
}
func array(v any) []any {
	if a, ok := v.([]any); ok {
		return a
	}
	return []any{}
}
func stringsOf(v any) []string {
	out := []string{}
	switch a := v.(type) {
	case []any:
		for _, v := range a {
			if s, ok := v.(string); ok {
				out = append(out, s)
			}
		}
	case []string:
		return a
	}
	return out
}
func contains(a []string, v string) bool {
	for _, s := range a {
		if s == v {
			return true
		}
	}
	return false
}
func clone(o Object) Object { raw, _ := json.Marshal(o); v, _ := decodeObject(string(raw)); return v }
func encode(v any) string   { b, _ := json.Marshal(v); return string(b) }
func fallback(o Object, k string, v any) any {
	if x, ok := o[k]; ok {
		return x
	}
	return v
}
