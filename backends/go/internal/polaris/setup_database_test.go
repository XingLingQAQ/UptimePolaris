// 使用 PostgreSQL 验证初始化与选库持久化。
// Use PostgreSQL to check setup and persistent database selection.

package polaris

import (
	"context"
	"database/sql"
	"net/url"
	"os"
	"strings"
	"sync"
	"testing"
)

func setupPostgresFixture(t *testing.T) string {
	t.Helper()
	base := os.Getenv("POLARIS_TEST_POSTGRES_URL")
	if base == "" {
		t.Skip("isolated PostgreSQL fixture unavailable")
	}
	u, err := url.Parse(base)
	if err != nil || u.Hostname() != "127.0.0.1" {
		t.Fatal("PostgreSQL fixture must use loopback")
	}
	db, err := sql.Open("pgx", base)
	if err != nil {
		t.Fatal(err)
	}
	name := "polaris_setup_" + strings.ReplaceAll(uuid(), "-", "")
	if _, err = db.Exec(`CREATE DATABASE ` + name); err != nil {
		db.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = db.Exec(`DROP DATABASE ` + name + ` WITH (FORCE)`); _ = db.Close() })
	u.Path = "/" + name
	return u.String()
}

func TestSetupDatabasePostgres(t *testing.T) {
	t.Run("new target", func(t *testing.T) {
		target := setupPostgresFixture(t)
		s := newUninitializedTestServer(t)
		code, result := s.request(t, "POST", "/api/auth/setup", Object{"credential": s.config.SetupKey, "username": "owner", "password": "fixture-password", "database": Object{"type": "postgres", "url": target}}, false)
		expectStatus(t, code, 200, result)
		code, result = s.request(t, "GET", "/api/auth/session", nil, false)
		expectStatus(t, code, 200, result)
		if result["authenticated"] != true || str(object(result["user"]), "username") != "owner" || result["setupDatabase"] != nil {
			t.Fatal(result)
		}
		db, err := sql.Open("pgx", target)
		if err != nil {
			t.Fatal(err)
		}
		defer db.Close()
		var users, sessions int
		if err := db.QueryRow(`SELECT count(*) FROM polaris_documents WHERE kind='user'`).Scan(&users); err != nil {
			t.Fatal(err)
		}
		if err := db.QueryRow(`SELECT count(*) FROM polaris_documents WHERE kind='session'`).Scan(&sessions); err != nil {
			t.Fatal(err)
		}
		if users != 1 || sessions != 1 {
			t.Fatalf("target has %d users and %d sessions", users, sessions)
		}
		config := s.config
		config.DatabaseURL = ""
		restarted := openTestServer(t, config)
		code, result = restarted.request(t, "POST", "/api/auth/login", Object{"username": "owner", "password": "fixture-password"}, false)
		expectStatus(t, code, 200, result)
	})
	t.Run("configured target", func(t *testing.T) {
		target := setupPostgresFixture(t)
		config := DefaultConfig()
		config.DataDir = t.TempDir()
		config.SetupKey = "fixture-setup-key"
		config.DatabaseURL = target
		s := openTestServer(t, config)
		tx, err := s.app.store.db.BeginTx(context.Background(), nil)
		if err != nil {
			t.Fatal(err)
		}
		if err = validateEmptyPostgres(context.Background(), tx, true); err != nil {
			_ = tx.Rollback()
			t.Fatalf("fresh configured database rejected: %v", err)
		}
		_ = tx.Rollback()
		code, result := s.request(t, "POST", "/api/auth/setup", Object{"credential": config.SetupKey, "username": "owner", "password": "fixture-password", "database": Object{"type": "postgres", "url": ""}}, false)
		expectStatus(t, code, 200, result)
		config.DatabaseURL = ""
		restarted := openTestServer(t, config)
		code, result = restarted.request(t, "POST", "/api/auth/login", Object{"username": "owner", "password": "fixture-password"}, false)
		expectStatus(t, code, 200, result)
	})
	t.Run("configured target nullable mismatch", func(t *testing.T) {
		target := setupPostgresFixture(t)
		config := DefaultConfig()
		config.DataDir = t.TempDir()
		config.SetupKey = "fixture-setup-key"
		config.DatabaseURL = target
		s := openTestServer(t, config)
		if _, err := s.app.store.db.Exec(`ALTER TABLE polaris_documents ALTER COLUMN data DROP NOT NULL`); err != nil {
			t.Fatal(err)
		}
		code, result := s.request(t, "POST", "/api/auth/setup", Object{"credential": config.SetupKey, "username": "owner", "password": "fixture-password", "database": Object{"type": "postgres", "url": ""}}, false)
		expectStatus(t, code, 503, result)
		if str(result, "error") != "database_initialization_failed" {
			t.Fatal(result)
		}
	})
	t.Run("unknown schema", func(t *testing.T) {
		target := setupPostgresFixture(t)
		db, err := sql.Open("pgx", target)
		if err != nil {
			t.Fatal(err)
		}
		defer db.Close()
		if _, err = db.Exec(`CREATE TABLE unrelated (id integer)`); err != nil {
			t.Fatal(err)
		}
		s := newUninitializedTestServer(t)
		code, result := s.request(t, "POST", "/api/auth/setup", Object{"credential": s.config.SetupKey, "username": "owner", "password": "fixture-password", "database": Object{"type": "postgres", "url": target}}, false)
		expectStatus(t, code, 503, result)
		if str(result, "error") != "database_initialization_failed" {
			t.Fatal(result)
		}
		code, result = s.request(t, "GET", "/api/auth/session", nil, false)
		expectStatus(t, code, 200, result)
		if result["needsSetup"] != true {
			t.Fatal(result)
		}
	})
	t.Run("failed connection retry", func(t *testing.T) {
		target := setupPostgresFixture(t)
		s := newUninitializedTestServer(t)
		input := Object{"credential": s.config.SetupKey, "username": "owner", "password": "fixture-password", "database": Object{"type": "postgres", "url": "postgres://fixture@127.0.0.1:1/fixture?sslmode=disable"}}
		code, result := s.request(t, "POST", "/api/auth/setup", input, false)
		expectStatus(t, code, 503, result)
		if str(result, "error") != "database_connection_failed" {
			t.Fatal(result)
		}
		input["database"] = Object{"type": "postgres", "url": target}
		code, result = s.request(t, "POST", "/api/auth/setup", input, false)
		expectStatus(t, code, 200, result)
	})
	t.Run("concurrent setup", func(t *testing.T) {
		target := setupPostgresFixture(t)
		s := newUninitializedTestServer(t)
		var wg sync.WaitGroup
		codes := make(chan int, 2)
		for _, name := range []string{"owner1", "owner2"} {
			wg.Add(1)
			go func(name string) {
				defer wg.Done()
				code, _ := s.request(t, "POST", "/api/auth/setup", Object{"credential": s.config.SetupKey, "username": name, "password": "fixture-password", "database": Object{"type": "postgres", "url": target}}, false)
				codes <- code
			}(name)
		}
		wg.Wait()
		close(codes)
		wins, rejected := 0, 0
		for code := range codes {
			if code == 200 {
				wins++
			}
			if code == 409 {
				rejected++
			}
		}
		if wins != 1 || rejected != 1 {
			t.Fatalf("wins=%d rejected=%d", wins, rejected)
		}
		users, err := s.app.store.list(context.Background(), "user")
		if err != nil || len(users) != 1 {
			t.Fatalf("users=%d error=%v", len(users), err)
		}
	})
}
