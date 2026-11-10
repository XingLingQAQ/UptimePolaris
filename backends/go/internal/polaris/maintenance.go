package polaris

import (
	_ "embed"
	"html"
	"net/http"
	"strings"
)

//go:embed maintenance-page.html
var maintenancePageHTML string

//go:embed maintenance.js
var maintenanceJS string

func maintenanceHTML(state Object) string {
	title := str(state, "title")
	if title == "" {
		title = "Under maintenance"
	}
	result := strings.NewReplacer("POLARIS_MAINTENANCE_TITLE", html.EscapeString(title), "POLARIS_MAINTENANCE_DESCRIPTION", html.EscapeString(str(state, "description")), "POLARIS_MAINTENANCE_END", html.EscapeString(str(state, "endsAt"))).Replace(maintenancePageHTML)
	if state["endsAt"] == nil {
		result = strings.Replace(result, `<p id="maintenance-end"`, `<p id="maintenance-end" hidden`, 1)
	}
	return result
}

func serveMaintenanceScript(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	if r.Method != "HEAD" {
		_, _ = w.Write([]byte(maintenanceJS))
	}
}
