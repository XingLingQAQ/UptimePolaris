package polaris

import (
	"context"
	"math"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"time"
)

var colorPattern = regexp.MustCompile(`^#[a-fA-F0-9]{6}$`)

func (a *App) taxonomyRoutes() {
	for _, spec := range []struct{ base, kind, key string }{{"/api/groups", "group", "groups"}, {"/api/tags", "tag", "tags"}, {"/api/admin/agent-groups", "agent_group", "groups"}, {"/api/admin/agent-tags", "agent_tag", "tags"}} {
		spec := spec
		a.route("GET "+spec.base, false, func(w http.ResponseWriter, r *http.Request) error {
			if strings.HasPrefix(spec.kind, "agent_") && !boolean(object(a.presentation(r.Context())["config"])["agentEnabled"]) {
				return failure("agent_page_disabled", 409)
			}
			rows, e := a.store.list(r.Context(), spec.kind)
			if e != nil {
				return e
			}
			members, e := a.store.list(r.Context(), "monitor")
			if strings.HasPrefix(spec.kind, "agent_") {
				members, e = a.store.list(r.Context(), "agent")
			}
			if e != nil {
				return e
			}
			for _, row := range rows {
				count := 0
				for _, member := range members {
					if strings.Contains(spec.kind, "tag") {
						if contains(stringsOf(member["tag_ids"]), str(row, "id")) {
							count++
						}
					} else if str(member, "group_id") == str(row, "id") {
						count++
					}
				}
				row["count"] = count
			}
			sort.Slice(rows, func(i, j int) bool {
				if integer(rows[i], "weight") == integer(rows[j], "weight") {
					return str(rows[i], "name") < str(rows[j], "name")
				}
				return integer(rows[i], "weight") < integer(rows[j], "weight")
			})
			respond(w, 200, Object{spec.key: rows})
			return nil
		})
		for _, method := range []string{"POST", "PUT", "DELETE"} {
			pattern := method + " " + spec.base
			if method != "POST" {
				pattern += "/{id}"
			}
			a.route(pattern, false, func(w http.ResponseWriter, r *http.Request) error {
				return a.taxonomyWrite(w, r, spec.kind)
			})
		}
	}
	a.route("PUT /api/admin/agents/{id}/taxonomy", false, func(w http.ResponseWriter, r *http.Request) error {
		b, e := body(r)
		if e != nil {
			return e
		}
		e = a.store.mutate(r.Context(), func(t *transaction) error {
			row, e := t.get("agent", r.PathValue("id"))
			if e != nil {
				return e
			}
			if row == nil {
				return failure("not_found", 404)
			}
			if id := str(b, "group_id"); id != "" {
				group, e := t.get("agent_group", id)
				if e != nil {
					return e
				}
				if group == nil {
					return failure("invalid_group", 400)
				}
			}
			for _, id := range stringsOf(b["tag_ids"]) {
				tag, e := t.get("agent_tag", id)
				if e != nil {
					return e
				}
				if tag == nil {
					return failure("invalid_tags", 400)
				}
			}
			row["group_id"] = b["group_id"]
			row["tag_ids"] = stringsOf(b["tag_ids"])
			return t.put("agent", str(row, "id"), row)
		})
		if e != nil {
			return e
		}
		respond(w, 200, Object{"ok": true})
		return nil
	})
	a.route("GET /api/admin/groups", false, func(w http.ResponseWriter, r *http.Request) error {
		rows, e := a.managedGroups(r.Context())
		if e != nil {
			return e
		}
		respond(w, 200, Object{"groups": rows, "agentEnabled": object(a.presentation(r.Context())["config"])["agentEnabled"]})
		return nil
	})
	for _, method := range []string{"POST", "PUT", "DELETE"} {
		path := method + " /api/admin/groups"
		if method != "POST" {
			path += "/{key}"
		}
		a.route(path, false, a.managedGroupWrite)
	}
	a.route("PUT /api/admin/groups/{key}/members", false, a.managedGroupMembers)
}

func (a *App) taxonomyWrite(w http.ResponseWriter, r *http.Request, kind string) error {
	var input Object
	var e error
	if r.Method != "DELETE" {
		input, e = body(r)
		if e != nil {
			return e
		}
	}
	id := r.PathValue("id")
	created := id == ""
	if created {
		id = uuid()
	}
	e = a.store.mutate(r.Context(), func(t *transaction) error {
		if r.Method == "DELETE" {
			return removeTaxonomy(t, kind, id)
		}
		return writeTaxonomy(t, kind, id, input, created)
	})
	if e != nil {
		return e
	}
	if created {
		respond(w, 201, Object{"id": id})
	} else {
		respond(w, 200, Object{"ok": true, "id": id})
	}
	return nil
}

// 重名检查、编号分配与写入共用事务。
// Keep duplicate checks, number allocation, and writes in the same transaction.
func writeTaxonomy(t *transaction, kind, id string, input Object, created bool) error {
	old, e := t.get(kind, id)
	if e != nil {
		return e
	}
	if !created && old == nil {
		return failure("not_found", 404)
	}
	if old == nil {
		old = Object{"id": id, "name": "", "weight": 0, "color": "#6366F1", "created_at": time.Now().Unix()}
		if kind == "group" {
			n, e := t.next("group")
			if e != nil {
				return e
			}
			old["num_id"] = n
		}
	}
	for _, k := range []string{"name", "weight", "color"} {
		if v, ok := input[k]; ok {
			old[k] = v
		}
	}
	name := strings.TrimSpace(str(old, "name"))
	if name == "" || len(name) > 100 {
		return failure("name_required", 400)
	}
	old["name"] = name
	if strings.Contains(kind, "tag") {
		if !colorPattern.MatchString(str(old, "color")) {
			return failure("color_invalid", 400)
		}
	} else if math.Abs(number(old["weight"])) > 100000 || math.Trunc(number(old["weight"])) != number(old["weight"]) {
		return failure("weight_invalid", 400)
	}
	all, e := t.list(kind)
	if e != nil {
		return e
	}
	for _, o := range all {
		if str(o, "id") != id && str(o, "name") == name {
			return failure("name_exists", 409)
		}
	}
	old["updated_at"] = time.Now().Unix()
	return t.put(kind, id, old)
}

func removeTaxonomy(t *transaction, kind, id string) error {
	row, e := t.get(kind, id)
	if e != nil {
		return e
	}
	if row == nil {
		return failure("not_found", 404)
	}
	memberKind := "monitor"
	if strings.HasPrefix(kind, "agent_") {
		memberKind = "agent"
	}
	members, e := t.list(memberKind)
	if e != nil {
		return e
	}
	for _, member := range members {
		changed := false
		if strings.Contains(kind, "tag") {
			tags := []string{}
			for _, tag := range stringsOf(member["tag_ids"]) {
				if tag != id {
					tags = append(tags, tag)
				} else {
					changed = true
				}
			}
			member["tag_ids"] = tags
		} else if str(member, "group_id") == id {
			member["group_id"] = nil
			changed = true
		}
		if changed {
			if e = t.put(memberKind, str(member, "id"), member); e != nil {
				return e
			}
		}
	}
	if kind == "group" {
		channels, e := t.list("notification")
		if e != nil {
			return e
		}
		for _, channel := range channels {
			scope := []string{}
			for _, g := range stringsOf(channel["group_ids"]) {
				if g != id {
					scope = append(scope, g)
				}
			}
			channel["group_ids"] = scope
			if e = t.put("notification", str(channel, "id"), channel); e != nil {
				return e
			}
		}
	}
	return t.remove(kind, id)
}

func (a *App) managedGroups(ctx context.Context) ([]Object, error) {
	monitor, e := a.store.list(ctx, "group")
	if e != nil {
		return nil, e
	}
	agents := []Object{}
	if boolean(object(a.presentation(ctx)["config"])["agentEnabled"]) {
		agents, e = a.store.list(ctx, "agent_group")
		if e != nil {
			return nil, e
		}
	}
	monitors, e := a.store.list(ctx, "monitor")
	if e != nil {
		return nil, e
	}
	machines, e := a.store.list(ctx, "agent")
	if e != nil {
		return nil, e
	}
	byName := map[string]Object{}
	for _, g := range monitor {
		count := 0
		for _, m := range monitors {
			if str(m, "group_id") == str(g, "id") {
				count++
			}
		}
		byName[str(g, "name")] = Object{"key": "monitor:" + str(g, "id"), "name": g["name"], "type": "monitor", "weight": g["weight"], "monitorId": g["id"], "agentId": nil, "monitorCount": count, "agentCount": 0}
	}
	for _, g := range agents {
		count := 0
		for _, m := range machines {
			if str(m, "group_id") == str(g, "id") {
				count++
			}
		}
		row := byName[str(g, "name")]
		if row == nil {
			row = Object{"key": "agent:" + str(g, "id"), "name": g["name"], "type": "agent", "weight": g["weight"], "monitorId": nil, "monitorCount": 0}
			byName[str(g, "name")] = row
		} else {
			row["type"] = "common"
		}
		row["agentId"] = g["id"]
		row["agentCount"] = count
	}
	out := []Object{}
	for _, g := range byName {
		out = append(out, g)
	}
	sort.Slice(out, func(i, j int) bool {
		if integer(out[i], "weight") == integer(out[j], "weight") {
			return str(out[i], "name") < str(out[j], "name")
		}
		return integer(out[i], "weight") < integer(out[j], "weight")
	})
	return out, nil
}
func (a *App) managedGroupWrite(w http.ResponseWriter, r *http.Request) error {
	groups, e := a.managedGroups(r.Context())
	if e != nil {
		return e
	}
	key := r.PathValue("key")
	var current Object
	for _, group := range groups {
		if str(group, "key") == key {
			current = group
		}
	}
	if key != "" && current == nil {
		return failure("not_found", 404)
	}
	var input Object
	if r.Method != "DELETE" {
		input, e = body(r)
		if e != nil {
			return e
		}
		name := strings.TrimSpace(str(input, "name"))
		kind := str(input, "type")
		if name == "" || len(name) > 100 || !contains([]string{"monitor", "agent", "common"}, kind) || math.Abs(number(input["weight"])) > 100000 {
			return failure("invalid_request", 400)
		}
		input["name"] = name
		if kind != "monitor" && !boolean(object(a.presentation(r.Context())["config"])["agentEnabled"]) {
			return failure("agent_page_disabled", 409)
		}
		for _, g := range groups {
			if str(g, "name") == name && str(g, "key") != key {
				return failure("name_exists", 409)
			}
		}
		if current != nil && (kind == "agent" && integer(current, "monitorCount") > 0 || kind == "monitor" && integer(current, "agentCount") > 0) && !boolean(input["confirm_membership_reset"]) {
			return failure("group_members_reset_required", 409)
		}
	}
	scope := r.URL.Query().Get("scope")
	if scope == "" {
		scope = "all"
	}
	if !contains([]string{"all", "monitor", "agent"}, scope) {
		return failure("invalid_request", 400)
	}
	resultKey := ""
	e = a.store.mutate(r.Context(), func(t *transaction) error {
		for _, side := range []string{"monitor", "agent"} {
			idField, kind := "monitorId", "group"
			if side == "agent" {
				idField, kind = "agentId", "agent_group"
			}
			id := str(current, idField)
			if r.Method == "DELETE" {
				if scope != "all" && scope != side {
					continue
				}
				if id != "" {
					if e = removeTaxonomy(t, kind, id); e != nil {
						return e
					}
				}
				continue
			}
			keep := str(input, "type") == "common" || str(input, "type") == side
			if !keep {
				if id != "" {
					if e = removeTaxonomy(t, kind, id); e != nil {
						return e
					}
				}
				continue
			}
			row, e := t.get(kind, id)
			if e != nil {
				return e
			}
			if row == nil {
				id = uuid()
				row = Object{"id": id, "created_at": time.Now().Unix()}
				if side == "monitor" {
					n, e := t.next("group")
					if e != nil {
						return e
					}
					row["num_id"] = n
				}
			}
			row["name"] = input["name"]
			row["weight"] = input["weight"]
			row["updated_at"] = time.Now().Unix()
			if e = t.put(kind, id, row); e != nil {
				return e
			}
			if resultKey == "" {
				resultKey = side + ":" + id
			}
		}
		return nil
	})
	if e != nil {
		return e
	}
	status := 200
	if key == "" {
		status = 201
	}
	respond(w, status, Object{"ok": true, "key": resultKey})
	return nil
}
func (a *App) managedGroupMembers(w http.ResponseWriter, r *http.Request) error {
	b, e := body(r)
	if e != nil {
		return e
	}
	side := str(b, "kind")
	action := str(b, "action")
	ids := stringsOf(b["ids"])
	if !contains([]string{"monitor", "agent"}, side) || !contains([]string{"add", "remove"}, action) || len(ids) < 1 || len(ids) > 500 {
		return failure("invalid_request", 400)
	}
	groups, e := a.managedGroups(r.Context())
	if e != nil {
		return e
	}
	groupID := ""
	for _, g := range groups {
		if str(g, "key") == r.PathValue("key") {
			field := "monitorId"
			if side == "agent" {
				field = "agentId"
			}
			groupID = str(g, field)
		}
	}
	if groupID == "" {
		return failure("invalid_group", 400)
	}
	e = a.store.mutate(r.Context(), func(t *transaction) error {
		for _, id := range ids {
			row, e := t.get(side, id)
			if e != nil {
				return e
			}
			if row == nil {
				return failure("not_found", 404)
			}
			if action == "add" {
				row["group_id"] = groupID
			} else if str(row, "group_id") == groupID {
				row["group_id"] = nil
			}
			if e = t.put(side, id, row); e != nil {
				return e
			}
		}
		return nil
	})
	if e != nil {
		return e
	}
	respond(w, 200, Object{"ok": true, "updated": len(ids)})
	return nil
}
