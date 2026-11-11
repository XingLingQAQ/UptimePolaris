package polaris

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type databaseConfig struct {
	URL string `json:"url"`
}

func readDatabaseConfig(dataDir string) (string, error) {
	raw, err := os.ReadFile(filepath.Join(dataDir, "database.json"))
	if errors.Is(err, os.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	var config databaseConfig
	if json.Unmarshal(raw, &config) != nil || config.URL == "" {
		return "", errors.New("invalid database configuration")
	}
	return config.URL, nil
}

// 先写入同目录临时文件并同步，再替换；0600 不替代 Windows ACL。
// Sync a temporary file in the same directory before replacement; mode 0600 does not replace Windows ACLs.
func writeDatabaseConfig(dataDir, databaseURL string) error {
	raw, err := json.Marshal(databaseConfig{URL: databaseURL})
	if err != nil {
		return err
	}
	file, err := os.CreateTemp(dataDir, ".database-*")
	if err != nil {
		return err
	}
	name := file.Name()
	defer os.Remove(name)
	if err = file.Chmod(0600); err != nil {
		file.Close()
		return err
	}
	if _, err = file.Write(raw); err != nil {
		file.Close()
		return err
	}
	if err = file.Sync(); err != nil {
		file.Close()
		return err
	}
	if err = file.Close(); err != nil {
		return err
	}
	return replaceDatabaseConfig(name, filepath.Join(dataDir, "database.json"))
}

// 允许空 schema 或完整但无业务数据的 Go 表；可保留初始化前的登录限流记录。
// Allow an empty schema or complete Go tables without business data; optionally retain pre-setup login limits.
func validateEmptyPostgres(ctx context.Context, db *sql.Tx, allowLoginLimits bool) error {
	rows, err := db.QueryContext(ctx, `SELECT c.relname, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND c.relkind IN ('r','p','v','m','S','f','i','I')`)
	if err != nil {
		return err
	}
	defer rows.Close()
	tables := map[string]bool{}
	allowed := map[string]bool{"polaris_documents": true, "polaris_readings": true, "polaris_leases": true, "polaris_sequences": true}
	indexes := map[string]bool{"polaris_documents_pkey": true, "polaris_readings_pkey": true, "polaris_leases_pkey": true, "polaris_sequences_pkey": true, "polaris_readings_monitor_time": true, "polaris_readings_time": true, "polaris_documents_agent_id_state": true, "polaris_documents_monitor_id_state": true, "polaris_documents_scheduled_at_time": true, "polaris_documents_queued_at_time": true}
	for rows.Next() {
		var name, kind string
		if err := rows.Scan(&name, &kind); err != nil {
			return err
		}
		if name == "polaris_readings_seq_seq" && kind == "S" {
			continue
		}
		if indexes[name] && kind == "i" {
			continue
		}
		if !allowed[name] || kind != "r" {
			return errors.New("database schema is not empty")
		}
		tables[name] = true
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if err := rows.Close(); err != nil {
		return err
	}
	if len(tables) != 0 && len(tables) != len(allowed) {
		return errors.New("incomplete database schema")
	}
	var unknownObjects bool
	err = db.QueryRowContext(ctx, `SELECT EXISTS(
		SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=current_schema()
		UNION ALL
		SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
		WHERE n.nspname=current_schema() AND t.typtype IN ('d','e','r','m')
	)`).Scan(&unknownObjects)
	if err != nil {
		return err
	}
	if unknownObjects {
		return errors.New("database schema is not empty")
	}
	if len(tables) == 0 {
		return nil
	}
	for _, name := range []string{"polaris_documents", "polaris_readings", "polaris_leases", "polaris_sequences"} {
		if _, err := db.ExecContext(ctx, "LOCK TABLE "+name+" IN ACCESS EXCLUSIVE MODE"); err != nil {
			return err
		}
	}
	err = db.QueryRowContext(ctx, `SELECT EXISTS(
		SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
		WHERE n.nspname=current_schema() AND NOT t.tgisinternal
		UNION ALL
		SELECT 1 FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace
		WHERE n.nspname=current_schema()
		UNION ALL
		SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
		WHERE n.nspname=current_schema() AND (c.relrowsecurity OR c.relforcerowsecurity)
	)`).Scan(&unknownObjects)
	if err != nil {
		return err
	}
	if unknownObjects {
		return errors.New("incompatible database schema")
	}
	constraints := map[string]string{}
	constraintRows, err := db.QueryContext(ctx, `SELECT c.relname, pg_get_constraintdef(k.oid) FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND k.contype <> 'n'`)
	if err != nil {
		return err
	}
	for constraintRows.Next() {
		var table, definition string
		if err := constraintRows.Scan(&table, &definition); err != nil {
			constraintRows.Close()
			return err
		}
		if constraints[table] != "" {
			constraintRows.Close()
			return errors.New("incompatible database constraints")
		}
		constraints[table] = definition
	}
	if err := constraintRows.Err(); err != nil {
		constraintRows.Close()
		return err
	}
	if err := constraintRows.Close(); err != nil {
		return err
	}
	if len(constraints) != 4 || constraints["polaris_documents"] != "PRIMARY KEY (kind, id)" || constraints["polaris_readings"] != "PRIMARY KEY (seq)" || constraints["polaris_leases"] != "PRIMARY KEY (id)" || constraints["polaris_sequences"] != "PRIMARY KEY (name)" {
		return errors.New("incompatible database constraints")
	}
	expected := map[string]map[string]string{
		"polaris_documents": {"kind": "text", "id": "text", "data": "text", "updated_at": "bigint"},
		"polaris_readings":  {"seq": "bigint", "monitor_id": "text", "ts": "bigint", "status": "integer", "value": "double precision", "code": "integer", "message": "text", "addons": "text"},
		"polaris_leases":    {"id": "text", "owner": "text", "expires_at": "bigint", "next_due": "bigint"},
		"polaris_sequences": {"name": "text", "value": "bigint"},
	}
	columns, err := db.QueryContext(ctx, `SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema=current_schema()`)
	if err != nil {
		return err
	}
	defer columns.Close()
	seen := 0
	for columns.Next() {
		var table, name, kind, isNullable string
		if err := columns.Scan(&table, &name, &kind, &isNullable); err != nil {
			return err
		}
		wantNullable := "NO"
		if table == "polaris_readings" && name == "value" {
			wantNullable = "YES"
		}
		if expected[table][name] != kind || isNullable != wantNullable {
			return errors.New("incompatible database schema")
		}
		seen++
	}
	if err := columns.Err(); err != nil {
		return err
	}
	if seen != 18 {
		return errors.New("incomplete database schema")
	}
	if err := columns.Close(); err != nil {
		return err
	}
	var count int
	for _, name := range []string{"polaris_documents", "polaris_readings", "polaris_leases", "polaris_sequences"} {
		query := "SELECT count(*) FROM " + name
		if name == "polaris_documents" && allowLoginLimits {
			query += " WHERE kind <> 'login_limit'"
		}
		if err := db.QueryRowContext(ctx, query).Scan(&count); err != nil {
			return err
		}
		if count != 0 {
			return errors.New("database has existing data")
		}
	}
	return nil
}

func validateSetupPostgres(value string) (string, error) {
	if len(value) > 4096 {
		return "", failure("invalid_database_url", 400)
	}
	u, err := url.Parse(value)
	if err != nil || !contains([]string{"postgres", "postgresql"}, u.Scheme) || u.Hostname() == "" || u.User == nil || u.User.Username() == "" || u.Path == "" || u.Path == "/" || u.Fragment != "" {
		return "", failure("invalid_database_url", 400)
	}
	query, err := url.ParseQuery(u.RawQuery)
	if err != nil {
		return "", failure("invalid_database_url", 400)
	}
	for key, values := range query {
		if key != "sslmode" || len(values) != 1 || !contains([]string{"verify-full", "require", "disable"}, values[0]) {
			return "", failure("invalid_database_url", 400)
		}
	}
	if query.Get("sslmode") == "disable" && !contains([]string{"localhost", "127.0.0.1", "::1"}, u.Hostname()) {
		return "", failure("invalid_database_url", 400)
	}
	if query.Get("sslmode") == "" {
		query.Set("sslmode", "verify-full")
		u.RawQuery = query.Encode()
	}
	return u.String(), nil
}

func (a *App) markSetupReady() {
	a.readyOnce.Do(func() { close(a.setupReady) })
}

func setupError(err error) error {
	var openErr *databaseOpenError
	if errors.As(err, &openErr) && openErr.connection {
		return failure("database_connection_failed", 503)
	}
	return failure("database_initialization_failed", 503)
}

func (a *App) finishDatabaseSetup(w http.ResponseWriter, r *http.Request, body Object, user Object) error {
	select {
	case <-a.setupReady:
		return failure("setup_complete", 409)
	default:
	}
	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()
	existing, err := a.store.list(ctx, "user")
	if err != nil {
		return failure("database_initialization_failed", 503)
	}
	if len(existing) != 0 {
		a.markSetupReady()
		return failure("setup_complete", 409)
	}

	target := a.config.DatabaseURL
	selection, selected := body["database"]
	if selected {
		choice := object(selection)
		if choice == nil {
			return failure("invalid_database_type", 400)
		}
		if value, exists := choice["url"]; exists {
			if _, valid := value.(string); !valid {
				return failure("invalid_database_url", 400)
			}
		}
		switch str(choice, "type") {
		case "sqlite":
			if strings.TrimSpace(str(choice, "url")) != "" {
				return failure("invalid_database_url", 400)
			}
			if a.store.postgres {
				target, err = filepath.Abs(filepath.Join(a.config.DataDir, "polaris.sqlite"))
				if err != nil {
					return failure("database_configuration_failed", 503)
				}
			}
		case "postgres":
			value := strings.TrimSpace(str(choice, "url"))
			if value == "" {
				if !a.store.postgres {
					return failure("invalid_database_url", 400)
				}
			} else {
				target, err = validateSetupPostgres(value)
				if err != nil {
					return err
				}
			}
		default:
			return failure("invalid_database_type", 400)
		}
	}

	candidate := a.store
	if target != a.config.DatabaseURL {
		candidate, err = openStore(ctx, target, strings.HasPrefix(target, "postgres://") || strings.HasPrefix(target, "postgresql://"))
		if err != nil {
			return setupError(err)
		}
		users, checkErr := candidate.list(ctx, "user")
		if checkErr != nil {
			candidate.Close()
			return failure("database_initialization_failed", 503)
		}
		if len(users) != 0 {
			candidate.Close()
			return failure("setup_complete", 409)
		}
	}
	if selected && candidate == a.store && a.store.postgres {
		if err = a.store.db.PingContext(ctx); err != nil {
			return failure("database_connection_failed", 503)
		}
		tx, checkErr := a.store.db.BeginTx(ctx, nil)
		if checkErr != nil {
			return failure("database_initialization_failed", 503)
		}
		_, checkErr = tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(751425306)`)
		if checkErr == nil {
			checkErr = validateEmptyPostgres(ctx, tx, true)
		}
		_ = tx.Rollback()
		if checkErr != nil {
			return failure("database_initialization_failed", 503)
		}
	}
	if selected {
		if !strings.HasPrefix(target, "postgres://") && !strings.HasPrefix(target, "postgresql://") && !strings.HasPrefix(target, "file:") && !strings.Contains(target, "?") {
			target, err = filepath.Abs(target)
			if err != nil {
				if candidate != a.store {
					candidate.Close()
				}
				return failure("database_configuration_failed", 503)
			}
		}
		if err = writeDatabaseConfig(a.config.DataDir, target); err != nil {
			if candidate != a.store {
				candidate.Close()
			}
			return failure("database_configuration_failed", 503)
		}
	}
	// 选库记录先落盘；账号创建失败后重试仍指向同一数据库。
	// Persist the selection first so retries after account-creation failure use the same database.
	if candidate != a.store {
		old := a.store
		a.store = candidate
		_ = old.Close()
	}
	a.config.DatabaseURL = target
	secret := token(32)
	settings, err := a.settings(ctx)
	if err != nil {
		return err
	}
	age := int(number(settings["security.sessionTtlDays"])) * 86400
	expires := time.Now().Unix() + int64(age)
	err = a.store.mutate(ctx, func(tx *transaction) error {
		users, err := tx.list("user")
		if err != nil {
			return err
		}
		if len(users) != 0 {
			return failure("setup_complete", 409)
		}
		if err = tx.put("user", str(user, "id"), user); err != nil {
			return err
		}
		return tx.put("session", digest(secret), Object{"user_id": str(user, "id"), "expires_at": expires})
	})
	if err != nil {
		var apiErr *apiError
		if errors.As(err, &apiErr) {
			a.markSetupReady()
			return apiErr
		}
		return failure("database_initialization_failed", 503)
	}
	a.markSetupReady()
	a.setCookie(w, r, secret, age)
	return nil
}
