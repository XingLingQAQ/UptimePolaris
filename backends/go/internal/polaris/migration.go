package polaris

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sort"
	"strings"
	"time"
)

type migrationTable struct {
	name    string
	columns []string
	rows    [][]any
}

// 复制业务文档、读数和编号；不继承源进程的调度租约。
// Copy business documents, readings, and numbering without inheriting the source process's scheduling leases.
var migrationColumns = map[string][]string{
	"polaris_documents": {"kind", "id", "data", "updated_at"},
	"polaris_readings":  {"seq", "monitor_id", "ts", "status", "value", "code", "message", "addons"},
	"polaris_sequences": {"name", "value"},
}

func (s *Store) snapshot(ctx context.Context) ([]migrationTable, error) {
	if s.postgres {
		return nil, failure("source_unavailable", 409)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, e := s.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if e != nil {
		return nil, e
	}
	defer tx.Rollback()
	names := []string{}
	for name := range migrationColumns {
		names = append(names, name)
	}
	sort.Strings(names)
	out := []migrationTable{}
	total, size := 0, 0
	for _, name := range names {
		columns := migrationColumns[name]
		table := migrationTable{name: name, columns: columns, rows: [][]any{}}
		rows, e := tx.QueryContext(ctx, `SELECT `+strings.Join(columns, ",")+` FROM `+name+` ORDER BY `+columns[0])
		if e != nil {
			return nil, e
		}
		for rows.Next() {
			values := make([]any, len(columns))
			pointers := make([]any, len(columns))
			for i := range values {
				pointers[i] = &values[i]
			}
			if e = rows.Scan(pointers...); e != nil {
				rows.Close()
				return nil, e
			}
			for i, v := range values {
				if b, ok := v.([]byte); ok {
					values[i] = string(b)
				}
			}
			size += len(encode(values))
			table.rows = append(table.rows, values)
			total++
			if len(table.rows) > 5000 || total > 10000 || size > 8<<20 {
				rows.Close()
				return nil, failure("source_too_large", 400)
			}
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			return nil, e
		}
		out = append(out, table)
	}
	return out, tx.Commit()
}

// MigrateOffline 要求调用方保持源库停写；复制完成后仍需另行切换连接配置。
// MigrateOffline requires source writes to remain stopped; connection configuration must be switched separately after copying.
func (a *App) MigrateOffline(ctx context.Context, target string, execute bool) (Object, error) {
	action := "preview"
	if execute {
		action = "execute"
	}
	payload, err := json.Marshal(Object{"url": target, "confirmed": execute})
	if err != nil {
		return nil, err
	}
	req := httptest.NewRequestWithContext(ctx, http.MethodPost, "/", bytes.NewReader(payload))
	req.SetPathValue("action", action)
	response := httptest.NewRecorder()
	if err = a.databaseMigration(response, req); err != nil {
		return nil, err
	}
	return decodeObject(response.Body.String())
}

func (a *App) databaseMigration(w http.ResponseWriter, r *http.Request) error {
	action := r.PathValue("action")
	if action != "preview" && action != "execute" {
		return failure("invalid_request", 400)
	}
	if a.store.postgres {
		return failure("source_unavailable", 409)
	}
	b, e := body(r)
	if e != nil {
		return e
	}
	execute := action == "execute"
	if execute && b["confirmed"] != true {
		return failure("invalid_request", 400)
	}
	target := str(b, "url")
	u, e := url.Parse(target)
	if e != nil || len(target) > 4096 || !contains([]string{"postgres", "postgresql"}, u.Scheme) || u.Hostname() == "" || u.Path == "" || u.Path == "/" || u.User == nil || u.User.Username() == "" || u.Fragment != "" {
		return failure("invalid_target", 400)
	}
	for key, values := range u.Query() {
		if key != "sslmode" || len(values) != 1 || !contains([]string{"verify-full", "require", "disable"}, values[0]) {
			return failure("invalid_target", 400)
		}
	}
	if u.Query().Get("sslmode") == "disable" && u.Hostname() != "127.0.0.1" && u.Hostname() != "::1" && u.Hostname() != "localhost" {
		return failure("invalid_target", 400)
	}
	if u.Query().Get("sslmode") == "" {
		query := u.Query()
		query.Set("sslmode", "verify-full")
		u.RawQuery = query.Encode()
	}
	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()
	tables, e := a.store.snapshot(ctx)
	if e != nil {
		return e
	}
	db, e := sql.Open("pgx", u.String())
	if e != nil {
		return failure("migration_failed", 503)
	}
	db.SetMaxOpenConns(1)
	defer db.Close()
	tx, e := db.BeginTx(ctx, nil)
	if e != nil {
		return failure("migration_failed", 503)
	}
	defer tx.Rollback()
	if _, e = tx.ExecContext(ctx, `SET LOCAL statement_timeout='45s'; SET LOCAL lock_timeout='5s'`); e != nil {
		return failure("migration_failed", 503)
	}
	if execute {
		if _, e = tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(751425307)`); e != nil {
			return failure("migration_failed", 503)
		}
	}
	rows, e := tx.QueryContext(ctx, `SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema() AND table_type='BASE TABLE' ORDER BY table_name`)
	if e != nil {
		return failure("migration_failed", 503)
	}
	names := []string{}
	for rows.Next() {
		var name string
		if e = rows.Scan(&name); e != nil {
			rows.Close()
			return failure("schema_mismatch", 400)
		}
		names = append(names, name)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return failure("migration_failed", 503)
	}
	needs := len(names) == 0
	if needs {
		var objects bool
		e = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() UNION ALL SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=current_schema())`).Scan(&objects)
		if e != nil {
			return failure("migration_failed", 503)
		}
		if objects {
			return failure("schema_mismatch", 400)
		}
	}
	if !needs {
		expected := []string{"polaris_documents", "polaris_leases", "polaris_readings", "polaris_sequences"}
		if strings.Join(names, ",") != strings.Join(expected, ",") {
			return failure("schema_mismatch", 400)
		}
		schemaColumns := map[string][]string{}
		for name, columns := range migrationColumns {
			schemaColumns[name] = columns
		}
		schemaColumns["polaris_leases"] = []string{"id", "owner", "expires_at", "next_due"}
		for name, expectedColumns := range schemaColumns {
			columnRows, e := tx.QueryContext(ctx, `SELECT column_name,data_type FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=$1 ORDER BY ordinal_position`, name)
			if e != nil {
				return failure("schema_mismatch", 400)
			}
			columns := []string{}
			for columnRows.Next() {
				var column, dataType string
				if e = columnRows.Scan(&column, &dataType); e != nil {
					columnRows.Close()
					return failure("schema_mismatch", 400)
				}
				expectedType := "text"
				if contains([]string{"updated_at", "seq", "ts", "expires_at", "next_due"}, column) || name == "polaris_sequences" && column == "value" {
					expectedType = "bigint"
				}
				if contains([]string{"status", "code"}, column) {
					expectedType = "integer"
				}
				if name == "polaris_readings" && column == "value" {
					expectedType = "double precision"
				}
				if dataType != expectedType {
					columnRows.Close()
					return failure("schema_mismatch", 400)
				}
				columns = append(columns, column)
			}
			columnRows.Close()
			if strings.Join(columns, ",") != strings.Join(expectedColumns, ",") {
				return failure("schema_mismatch", 400)
			}
			keyRows, e := tx.QueryContext(ctx, `SELECT kcu.column_name FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON tc.constraint_schema=kcu.constraint_schema AND tc.constraint_name=kcu.constraint_name WHERE tc.table_schema=current_schema() AND tc.table_name=$1 AND tc.constraint_type='PRIMARY KEY' ORDER BY kcu.ordinal_position`, name)
			if e != nil {
				return failure("schema_mismatch", 400)
			}
			keys := []string{}
			for keyRows.Next() {
				var key string
				if e = keyRows.Scan(&key); e != nil {
					keyRows.Close()
					return failure("schema_mismatch", 400)
				}
				keys = append(keys, key)
			}
			keyRows.Close()
			expectedKeys := []string{expectedColumns[0]}
			if name == "polaris_documents" {
				expectedKeys = []string{"kind", "id"}
			}
			if strings.Join(keys, ",") != strings.Join(expectedKeys, ",") {
				return failure("schema_mismatch", 400)
			}
		}
		if execute {
			if _, e = tx.ExecContext(ctx, `LOCK TABLE polaris_documents,polaris_readings,polaris_sequences,polaris_leases IN ACCESS EXCLUSIVE MODE`); e != nil {
				return failure("migration_failed", 503)
			}
		}
		for _, name := range names {
			var populated bool
			if e = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM `+name+`)`).Scan(&populated); e != nil {
				return failure("migration_failed", 503)
			}
			if populated {
				return failure("target_not_empty", 400)
			}
		}
	}
	if needs && execute {
		for _, statement := range []string{
			`CREATE TABLE polaris_documents(kind TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,updated_at BIGINT NOT NULL,PRIMARY KEY(kind,id))`,
			`CREATE TABLE polaris_readings(seq BIGSERIAL PRIMARY KEY,monitor_id TEXT NOT NULL,ts BIGINT NOT NULL,status INTEGER NOT NULL,value DOUBLE PRECISION,code INTEGER NOT NULL,message TEXT NOT NULL,addons TEXT NOT NULL)`,
			`CREATE INDEX polaris_readings_monitor_time ON polaris_readings(monitor_id,ts)`,
			`CREATE TABLE polaris_leases(id TEXT PRIMARY KEY,owner TEXT NOT NULL,expires_at BIGINT NOT NULL,next_due BIGINT NOT NULL)`,
			`CREATE TABLE polaris_sequences(name TEXT PRIMARY KEY,value BIGINT NOT NULL)`,
		} {
			if _, e = tx.ExecContext(ctx, statement); e != nil {
				return failure("migration_failed", 503)
			}
		}
	}
	counts := []Object{}
	total := 0
	for _, table := range tables {
		counts = append(counts, Object{"name": table.name, "rows": len(table.rows)})
		total += len(table.rows)
		if execute {
			placeholders := []string{}
			for i := range table.columns {
				placeholders = append(placeholders, fmt.Sprintf("$%d", i+1))
			}
			statement := `INSERT INTO ` + table.name + ` (` + strings.Join(table.columns, ",") + `) VALUES (` + strings.Join(placeholders, ",") + ")"
			for _, row := range table.rows {
				if _, e = tx.ExecContext(ctx, statement, row...); e != nil {
					return failure("migration_failed", 503)
				}
			}
		}
	}
	if execute {
		if _, e = tx.ExecContext(ctx, `SELECT setval(pg_get_serial_sequence('polaris_readings','seq'),COALESCE(MAX(seq),1),MAX(seq) IS NOT NULL) FROM polaris_readings`); e != nil {
			return failure("migration_failed", 503)
		}
		for _, table := range tables {
			var count int
			if e = tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM `+table.name).Scan(&count); e != nil || count != len(table.rows) {
				return failure("source_changed", 400)
			}
		}
		if e = tx.Commit(); e != nil {
			return failure("migration_failed", 503)
		}
	}
	result := Object{"ok": true, "tables": counts, "totalRows": total, "targetNeedsInitialization": needs}
	if execute {
		result["copied"] = true
	}
	respond(w, 200, result)
	return nil
}
