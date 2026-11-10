package polaris

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
)

//go:embed brand-mark.json
var brandMarkJSON []byte
var brandMark = func() Object {
	var mark Object
	if e := json.Unmarshal(brandMarkJSON, &mark); e != nil {
		panic(e)
	}
	return mark
}()

func brandIcon(r *http.Request) string {
	box := "0 0 32 32"
	container := r.URL.Query().Get("container") == "1"
	if r.URL.Query().Get("tight") == "1" && !container {
		box = str(brandMark, "tightViewBox")
	}
	dimensions := ""
	if size, e := strconv.Atoi(r.URL.Query().Get("size")); e == nil && size >= 8 && size <= 1024 {
		dimensions = fmt.Sprintf(` width="%d" height="%d"`, size, size)
	}
	plate := ""
	if container {
		plate = `<rect x="0" y="0" width="32" height="32" rx="8" fill="#ffffff"/>`
	}
	return fmt.Sprintf(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="%s"%s>%s<path d="%s" fill="none" stroke="%s" stroke-width="4" stroke-linecap="round"/></svg>`, box, dimensions, plate, str(brandMark, "path"), str(brandMark, "blue"))
}
