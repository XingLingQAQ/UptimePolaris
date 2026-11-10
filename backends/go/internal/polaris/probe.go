package polaris

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/miekg/dns"
	"golang.org/x/net/icmp"
	"golang.org/x/net/ipv4"
	"golang.org/x/net/ipv6"
	"golang.org/x/net/publicsuffix"
)

type CheckResult struct {
	Status     int      `json:"status"`
	LatencyMs  float64  `json:"latencyMs"`
	StatusCode int      `json:"statusCode"`
	Message    string   `json:"message"`
	DaysLeft   *float64 `json:"daysLeft,omitempty"`
	Records    []string `json:"records,omitempty"`
}

func options(m Object) Object {
	var o Object
	_ = json.Unmarshal([]byte(str(m, "options_json")), &o)
	if o == nil {
		return Object{}
	}
	return o
}
func checkSource(m Object) (string, string) {
	source := object(options(m)["check_source"])
	if str(source, "type") == "agent" {
		return "agent", str(source, "agent_id")
	}
	return "server", ""
}
func elapsed(start time.Time) float64 { return float64(time.Since(start).Microseconds()) / 1000 }
func expectedStatus(spec string, code int) bool {
	for _, part := range strings.Split(spec, ",") {
		rangeParts := strings.Split(strings.TrimSpace(part), "-")
		lo, e := strconv.Atoi(rangeParts[0])
		if e != nil {
			continue
		}
		hi := lo
		if len(rangeParts) == 2 {
			hi, _ = strconv.Atoi(rangeParts[1])
		}
		if code >= lo && code <= hi {
			return true
		}
	}
	return false
}

// 主动检查共用总超时；传输错误归为 DOWN，成功但超出延迟阈值归为 WARN。
// Active checks share an overall deadline; transport errors become DOWN, slow successes become WARN.
func (a *App) probe(ctx context.Context, m Object) CheckResult {
	ctx, cancel := context.WithTimeout(ctx, time.Duration(integer(m, "timeout_ms"))*time.Millisecond)
	defer cancel()
	start := time.Now()
	o := options(m)
	result := CheckResult{Status: 1}
	var err error
	switch str(m, "type") {
	case "http":
		result, err = probeHTTP(ctx, m, o)
	case "tcp", "udp":
		err = probeSocket(ctx, m, o)
	case "icmp":
		err = probeICMP(ctx, str(m, "target"))
	case "dns":
		result, err = probeDNS(ctx, str(m, "target"), object(o["dns"]))
	case "tls":
		result, err = probeTLS(ctx, str(m, "target"), str(o, "serverName"), integer(m, "warn_days"))
	case "websocket":
		err = probeWebSocket(ctx, m, o)
	default:
		err = fmt.Errorf("monitor is not actively probeable")
	}
	if result.LatencyMs == 0 {
		result.LatencyMs = elapsed(start)
	}
	if err != nil {
		result.Status = 0
		result.Message = err.Error()
		if len(result.Message) > 1024 {
			result.Message = result.Message[:1024]
		}
	}
	if result.Status == 1 && number(o["maxLatencyMs"]) > 0 && result.LatencyMs > number(o["maxLatencyMs"]) {
		result.Status = 2
		result.Message = "response exceeded latency threshold"
	}
	return result
}

// 仅在正文断言需要时读取响应体，最多读取 4 MiB。
// Read at most 4 MiB of response content, only when body assertions require it.
func probeHTTP(ctx context.Context, m, o Object) (CheckResult, error) {
	result := CheckResult{Status: 1}
	req, err := http.NewRequestWithContext(ctx, str(m, "method"), str(m, "target"), strings.NewReader(str(o, "body")))
	if err != nil {
		return result, err
	}
	for k, v := range object(o["headers"]) {
		if s, ok := v.(string); ok {
			req.Header.Set(k, s)
		}
	}
	auth := object(o["auth"])
	switch str(auth, "type") {
	case "basic":
		req.SetBasicAuth(str(auth, "username"), str(auth, "password"))
	case "bearer":
		req.Header.Set("Authorization", "Bearer "+str(auth, "token"))
	}
	client := &http.Client{Transport: &http.Transport{Proxy: http.ProxyFromEnvironment, DisableKeepAlives: true, TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12}}, CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= 10 {
			return fmt.Errorf("too many redirects")
		}
		return nil
	}}
	response, err := client.Do(req)
	if err != nil {
		return result, err
	}
	defer response.Body.Close()
	result.StatusCode = response.StatusCode
	if !expectedStatus(str(m, "expected_status"), response.StatusCode) {
		return result, fmt.Errorf("unexpected HTTP status %d", response.StatusCode)
	}
	var content []byte
	if str(m, "keyword") != "" || str(o, "jsonPath") != "" {
		content, err = io.ReadAll(io.LimitReader(response.Body, 4<<20))
		if err != nil {
			return result, err
		}
	}
	if keyword := str(m, "keyword"); keyword != "" && !bytes.Contains(content, []byte(keyword)) {
		return result, fmt.Errorf("response keyword missing")
	}
	if name := str(o, "headerName"); name != "" {
		values, exists := response.Header[http.CanonicalHeaderKey(name)]
		if !exists || !strings.Contains(strings.Join(values, ", "), str(o, "headerExpected")) {
			return result, fmt.Errorf("response header mismatch")
		}
	}
	if path := str(o, "jsonPath"); path != "" {
		var value any
		if err = json.Unmarshal(content, &value); err != nil {
			return result, fmt.Errorf("response is not JSON")
		}
		path = regexp.MustCompile(`\[(\d+)\]`).ReplaceAllString(path, ".$1")
		for _, part := range strings.Split(strings.TrimPrefix(path, "."), ".") {
			switch current := value.(type) {
			case map[string]any:
				var exists bool
				value, exists = current[part]
				if !exists {
					return result, fmt.Errorf("JSON path not found")
				}
			case []any:
				i, e := strconv.Atoi(part)
				if e != nil || i < 0 || i >= len(current) {
					return result, fmt.Errorf("JSON path not found")
				} else {
					value = current[i]
				}
			default:
				return result, fmt.Errorf("JSON path not found")
			}
		}
		text, ok := value.(string)
		if !ok {
			text = encode(value)
		}
		if text != str(o, "jsonExpected") {
			return result, fmt.Errorf("JSON value mismatch")
		}
	}
	return result, nil
}

func packetBytes(value, encoding string) ([]byte, error) {
	if encoding == "hex" {
		return hex.DecodeString(strings.Join(strings.Fields(value), ""))
	}
	return []byte(value), nil
}
func probeSocket(ctx context.Context, m, o Object) error {
	network := str(m, "type")
	conn, err := (&net.Dialer{}).DialContext(ctx, network, str(m, "target"))
	if err != nil {
		return err
	}
	defer conn.Close()
	stop := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stop()
	if deadline, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(deadline)
	}
	send := str(o, "send")
	if network == "udp" {
		send, _ = fallback(o, "send", "ping").(string)
	}
	encoding := str(o, "encoding")
	payload, err := packetBytes(send, encoding)
	if err != nil {
		return err
	}
	expected, err := packetBytes(str(o, "expect"), encoding)
	if err != nil {
		return err
	}
	if len(payload) > 0 {
		if _, err = conn.Write(payload); err != nil {
			return err
		}
	}
	if network == "udp" || len(expected) > 0 {
		buffer := make([]byte, 65536)
		received := 0
		for received < len(buffer) {
			n, err := conn.Read(buffer[received:])
			received += n
			if network == "udp" && n == 0 && err != nil {
				return err
			}
			if bytes.Contains(buffer[:received], expected) {
				return nil
			}
			if err != nil {
				return err
			}
			if network == "udp" {
				break
			}
		}
		return fmt.Errorf("response did not match expected bytes")
	}
	return nil
}

func probeWebSocket(ctx context.Context, m, o Object) error {
	headers := http.Header{}
	for k, v := range object(o["headers"]) {
		if s, ok := v.(string); ok {
			headers.Set(k, s)
		}
	}
	dialer := websocket.Dialer{HandshakeTimeout: time.Duration(integer(m, "timeout_ms")) * time.Millisecond, Proxy: http.ProxyFromEnvironment, TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12}}
	conn, response, err := dialer.DialContext(ctx, str(m, "target"), headers)
	if response != nil && response.Body != nil {
		defer response.Body.Close()
	}
	if err != nil {
		return err
	}
	defer conn.Close()
	stop := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stop()
	conn.SetReadLimit(4 << 20)
	if deadline, ok := ctx.Deadline(); ok {
		_ = conn.SetReadDeadline(deadline)
		_ = conn.SetWriteDeadline(deadline)
	}
	if send := str(o, "send"); send != "" {
		if err = conn.WriteMessage(websocket.TextMessage, []byte(send)); err != nil {
			return err
		}
	}
	if expect := str(o, "expect"); expect != "" {
		_, message, err := conn.ReadMessage()
		if err != nil {
			return err
		}
		if !bytes.Contains(message, []byte(expect)) {
			return fmt.Errorf("WebSocket response mismatch")
		}
	}
	return nil
}

func probeTLS(ctx context.Context, target, serverName string, warnDays int64) (CheckResult, error) {
	result := CheckResult{Status: 1}
	host, _, err := net.SplitHostPort(target)
	if err != nil {
		return result, err
	}
	if serverName == "" {
		serverName = host
	}
	conn, err := (&net.Dialer{}).DialContext(ctx, "tcp", target)
	if err != nil {
		return result, err
	}
	defer conn.Close()
	if deadline, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(deadline)
	}
	// Read the served chain even when verification fails. / 验证失败也保留真实证书链。
	secured := tls.Client(conn, &tls.Config{ServerName: serverName, InsecureSkipVerify: true, MinVersion: tls.VersionTLS12})
	if err = secured.HandshakeContext(ctx); err != nil {
		return result, err
	}
	state := secured.ConnectionState()
	if len(state.PeerCertificates) == 0 {
		return result, fmt.Errorf("server provided no certificate")
	}
	leaf := state.PeerCertificates[0]
	days := time.Until(leaf.NotAfter).Hours() / 24
	result.DaysLeft = &days
	intermediates := x509.NewCertPool()
	for _, certificate := range state.PeerCertificates[1:] {
		intermediates.AddCert(certificate)
	}
	if _, err = leaf.Verify(x509.VerifyOptions{DNSName: serverName, Intermediates: intermediates}); err != nil {
		result.Status = 2
		result.Message = "certificate verification failed: " + err.Error()
	} else if days <= float64(warnDays) {
		result.Status = 2
		result.Message = "certificate expires soon"
	} else {
		result.Message = "certificate valid"
	}
	return result, nil
}

func probeDNS(ctx context.Context, host string, o Object) (CheckResult, error) {
	if o == nil {
		o = Object{}
	}
	result := CheckResult{Status: 1, Records: []string{}}
	recordType := str(o, "recordType")
	if recordType == "" {
		recordType = "A"
	}
	qtype, ok := dns.StringToType[recordType]
	if !ok {
		return result, fmt.Errorf("invalid DNS record type")
	}
	resolver := str(o, "resolver")
	if resolver == "" {
		var err error
		result.Records, err = systemDNS(ctx, host, recordType)
		if err != nil {
			return result, err
		}
	} else if strings.HasPrefix(resolver, "https://") {
		u, err := url.Parse(resolver)
		if err != nil {
			return result, err
		}
		query := u.Query()
		query.Set("name", host)
		query.Set("type", recordType)
		u.RawQuery = query.Encode()
		req, _ := http.NewRequestWithContext(ctx, "GET", u.String(), nil)
		req.Header.Set("Accept", "application/dns-json")
		response, err := http.DefaultClient.Do(req)
		if err != nil {
			return result, err
		}
		defer response.Body.Close()
		if response.StatusCode != 200 {
			return result, fmt.Errorf("DNS resolver returned HTTP %d", response.StatusCode)
		}
		var answer struct {
			Status int
			Answer []struct {
				Type uint16
				Data string
			}
		}
		if err = json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&answer); err != nil {
			return result, err
		}
		if answer.Status != 0 {
			return result, fmt.Errorf("DNS response code %d", answer.Status)
		}
		for _, row := range answer.Answer {
			if row.Type == qtype {
				result.Records = append(result.Records, row.Data)
			}
		}
	} else {
		message := new(dns.Msg)
		message.SetQuestion(dns.Fqdn(host), qtype)
		client := &dns.Client{Timeout: 5 * time.Second}
		answer, _, err := client.ExchangeContext(ctx, message, resolver)
		if err != nil {
			return result, err
		}
		if answer.Truncated {
			client.Net = "tcp"
			answer, _, err = client.ExchangeContext(ctx, message, resolver)
			if err != nil {
				return result, err
			}
		}
		if answer.Rcode != dns.RcodeSuccess {
			return result, fmt.Errorf("DNS response code %s", dns.RcodeToString[answer.Rcode])
		}
		for _, rr := range answer.Answer {
			if rr.Header().Rrtype != qtype {
				continue
			}
			switch value := rr.(type) {
			case *dns.A:
				result.Records = append(result.Records, value.A.String())
			case *dns.AAAA:
				result.Records = append(result.Records, value.AAAA.String())
			case *dns.CNAME:
				result.Records = append(result.Records, value.Target)
			case *dns.MX:
				result.Records = append(result.Records, fmt.Sprintf("%d %s", value.Preference, value.Mx))
			case *dns.TXT:
				result.Records = append(result.Records, strings.Join(value.Txt, ""))
			case *dns.NS:
				result.Records = append(result.Records, value.Ns)
			}
		}
	}
	if len(result.Records) == 0 {
		return result, fmt.Errorf("DNS response contained no %s records", recordType)
	}
	if expected := str(o, "expected"); expected != "" {
		matched := false
		for _, value := range result.Records {
			if strings.Contains(value, expected) {
				matched = true
			}
		}
		if !matched {
			return result, fmt.Errorf("DNS answer mismatch")
		}
	}
	result.Message = strings.Join(result.Records, ", ")
	return result, nil
}

func systemDNS(ctx context.Context, host, kind string) ([]string, error) {
	out := []string{}
	resolver := net.DefaultResolver
	switch kind {
	case "A", "AAAA":
		addresses, e := resolver.LookupIPAddr(ctx, host)
		if e != nil {
			return nil, e
		}
		for _, address := range addresses {
			if kind == "A" && address.IP.To4() != nil || kind == "AAAA" && address.IP.To4() == nil {
				out = append(out, address.IP.String())
			}
		}
	case "CNAME":
		canonical, e := resolver.LookupCNAME(ctx, host)
		if e != nil {
			return nil, e
		}
		if !strings.EqualFold(strings.TrimSuffix(canonical, "."), strings.TrimSuffix(host, ".")) {
			out = append(out, canonical)
		}
	case "MX":
		records, e := resolver.LookupMX(ctx, host)
		if e != nil {
			return nil, e
		}
		for _, record := range records {
			out = append(out, fmt.Sprintf("%d %s", record.Pref, record.Host))
		}
	case "TXT":
		return resolver.LookupTXT(ctx, host)
	case "NS":
		records, e := resolver.LookupNS(ctx, host)
		if e != nil {
			return nil, e
		}
		for _, record := range records {
			out = append(out, record.Host)
		}
	}
	return out, nil
}

func icmpPermission() bool {
	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()
	return probeICMP(ctx, "127.0.0.1") == nil
}
func probeICMP(ctx context.Context, host string) error {
	addresses, err := net.DefaultResolver.LookupIPAddr(ctx, host)
	if err != nil {
		return err
	}
	if len(addresses) == 0 {
		return fmt.Errorf("no IP address")
	}
	address := addresses[0]
	network, listen, protocol := "ip4:icmp", "0.0.0.0", 1
	var echoType icmp.Type = ipv4.ICMPTypeEcho
	var replyType icmp.Type = ipv4.ICMPTypeEchoReply
	if address.IP.To4() == nil {
		network, listen, protocol = "ip6:ipv6-icmp", "::", 58
		echoType = ipv6.ICMPTypeEchoRequest
		replyType = ipv6.ICMPTypeEchoReply
	}
	conn, err := icmp.ListenPacket(network, listen)
	if err != nil {
		return fmt.Errorf("ICMP permission unavailable: %w", err)
	}
	defer conn.Close()
	if deadline, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(deadline)
	}
	id := int(time.Now().UnixNano() & 0xffff)
	payload := []byte(token(12))
	packet, err := (&icmp.Message{Type: echoType, Code: 0, Body: &icmp.Echo{ID: id, Seq: 1, Data: payload}}).Marshal(nil)
	if err != nil {
		return err
	}
	if _, err = conn.WriteTo(packet, &net.IPAddr{IP: address.IP, Zone: address.Zone}); err != nil {
		return err
	}
	buffer := make([]byte, 1500)
	for {
		n, _, err := conn.ReadFrom(buffer)
		if err != nil {
			return err
		}
		message, err := icmp.ParseMessage(protocol, buffer[:n])
		if err != nil {
			continue
		}
		if message.Type == replyType {
			if echo, ok := message.Body.(*icmp.Echo); ok && echo.ID == id && bytes.Equal(echo.Data, payload) {
				return nil
			}
		}
	}
}

func targetHost(m Object) (string, string) {
	target := str(m, "target")
	switch str(m, "type") {
	case "http", "websocket":
		u, e := url.Parse(target)
		if e != nil {
			return "", ""
		}
		port := u.Port()
		if port == "" {
			if u.Scheme == "https" || u.Scheme == "wss" {
				port = "443"
			} else {
				port = "80"
			}
		}
		return u.Hostname(), net.JoinHostPort(u.Hostname(), port)
	case "dns", "icmp":
		return target, net.JoinHostPort(target, "443")
	default:
		host, _, _ := net.SplitHostPort(target)
		return host, target
	}
}

func sslCacheKey(m Object, source string, now int64) string {
	host, _ := targetHost(m)
	authority := sslAuthority(m)
	return fmt.Sprintf("%s|%s|%s|%s|%d", source, host, authority, str(options(m), "serverName"), now/86400)
}
func sslAuthority(m Object) string {
	host, authority := targetHost(m)
	if str(m, "type") == "http" || str(m, "type") == "websocket" {
		u, e := url.Parse(str(m, "target"))
		if e == nil && u.Port() == "" {
			return net.JoinHostPort(host, "443")
		}
	}
	return authority
}

func (a *App) addons(ctx context.Context, m, previous Object) Object {
	out := Object{}
	host, _ := targetHost(m)
	if host == "" || net.ParseIP(host) != nil {
		return out
	}
	now := time.Now().Unix()
	var mu chan struct{} = make(chan struct{}, 1)
	done := make(chan struct{}, 3)
	count := 0
	for _, kind := range []string{"ssl", "domain", "dns"} {
		if !boolean(m["check_"+kind]) {
			continue
		}
		count++
		go func(kind string) {
			defer func() { done <- struct{}{} }()
			ctx, cancel := context.WithTimeout(ctx, time.Duration(integer(m, "timeout_ms"))*time.Millisecond)
			defer cancel()
			reading := probeAddon(ctx, m, previous, kind, now)
			mu <- struct{}{}
			out[kind] = reading
			<-mu
		}(kind)
	}
	for range count {
		<-done
	}
	return out
}

// 同日同来源的 TLS 读数复用，告警阈值仍按本次配置重新判断。
// Reuse same-day TLS observations for the same source, but reevaluate the current warning threshold.
func probeAddon(ctx context.Context, m, previous Object, kind string, now int64) Object {
	host, _ := targetHost(m)
	authority := sslAuthority(m)
	o := options(m)
	cached := object(previous[kind])
	reading := Object{"st": 2, "days": nil, "msg": "", "ts": now}
	var result CheckResult
	var err error
	if kind == "ssl" && cached != nil && str(cached, "checkKey") == sslCacheKey(m, "server", now) {
		reading = clone(cached)
		if reading["days"] != nil && str(reading, "verification") == "valid" {
			if number(reading["days"]) > number(m["warn_days"]) {
				reading["st"] = 1
			} else {
				reading["st"] = 2
			}
		}
		return reading
	}
	switch kind {
	case "ssl":
		result, err = probeTLS(ctx, authority, str(o, "serverName"), integer(m, "warn_days"))
		reading["checkKey"] = sslCacheKey(m, "server", now)
	case "domain":
		result, err = probeDomain(ctx, host, integer(m, "warn_days"))
	case "dns":
		result, err = probeDNS(ctx, host, object(o["dns"]))
	}
	if err != nil {
		reading["msg"] = err.Error()
		return reading
	}
	reading["st"] = result.Status
	reading["msg"] = result.Message
	if result.DaysLeft != nil {
		reading["days"] = *result.DaysLeft
	}
	if kind == "ssl" && (result.Status == 1 || result.Message == "certificate expires soon") {
		reading["verification"] = "valid"
	}
	if kind == "dns" {
		reading["records"] = result.Records
	}
	return reading
}

func probeDomain(ctx context.Context, host string, warnDays int64) (CheckResult, error) {
	result := CheckResult{Status: 2}
	domain, err := publicsuffix.EffectiveTLDPlusOne(host)
	if err != nil {
		return result, err
	}
	base, e := rdapBase(ctx, domain)
	if e != nil {
		return result, e
	}
	req, _ := http.NewRequestWithContext(ctx, "GET", base+"domain/"+url.PathEscape(domain), nil)
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		return result, err
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		return result, fmt.Errorf("RDAP returned HTTP %d", response.StatusCode)
	}
	var data struct {
		Events []struct {
			EventAction string `json:"eventAction"`
			EventDate   string `json:"eventDate"`
		}
	}
	if err = json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&data); err != nil {
		return result, err
	}
	for _, event := range data.Events {
		if event.EventAction == "expiration" {
			expiry, e := time.Parse(time.RFC3339, event.EventDate)
			if e != nil {
				continue
			}
			days := time.Until(expiry).Hours() / 24
			result.DaysLeft = &days
			if days > float64(warnDays) {
				result.Status = 1
			}
			result.Message = "domain registration expiry"
			return result, nil
		}
	}
	result.Message = "domain expiry is not publicly available"
	return result, nil
}

var rdapBootstrapMu sync.RWMutex
var rdapBootstrapAt time.Time
var rdapBootstrap map[string]string

func rdapBase(ctx context.Context, domain string) (string, error) {
	tld := domain[strings.LastIndex(domain, ".")+1:]
	rdapBootstrapMu.RLock()
	cached := time.Since(rdapBootstrapAt) < 24*time.Hour
	base := rdapBootstrap[tld]
	rdapBootstrapMu.RUnlock()
	if cached && base != "" {
		return base, nil
	}
	if mapping, err := fetchRdapBootstrap(ctx); err == nil {
		rdapBootstrapMu.Lock()
		rdapBootstrap = mapping
		rdapBootstrapAt = time.Now()
		rdapBootstrapMu.Unlock()
		if mapping[tld] != "" {
			return mapping[tld], nil
		}
	}
	fallback := map[string]string{"com": "https://rdap.verisign.com/com/v1/", "net": "https://rdap.verisign.com/net/v1/", "org": "https://rdap.publicinterestregistry.org/rdap/", "io": "https://rdap.identitydigital.services/rdap/", "dev": "https://rdap.nic.google/", "app": "https://rdap.nic.google/"}
	if fallback[tld] != "" {
		return fallback[tld], nil
	}
	return "", fmt.Errorf("no authoritative RDAP endpoint for .%s", tld)
}

func fetchRdapBootstrap(ctx context.Context) (map[string]string, error) {
	req, _ := http.NewRequestWithContext(ctx, "GET", "https://data.iana.org/rdap/dns.json", nil)
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("RDAP bootstrap returned HTTP %d", response.StatusCode)
	}
	var data struct {
		Services [][][]string `json:"services"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 2<<20)).Decode(&data); err != nil {
		return nil, err
	}
	mapping := map[string]string{}
	for _, service := range data.Services {
		if len(service) < 2 {
			continue
		}
		endpoint := ""
		for _, candidate := range service[1] {
			u, err := url.Parse(candidate)
			if err == nil && u.Scheme == "https" && u.Host != "" {
				endpoint = strings.TrimRight(candidate, "/") + "/"
				break
			}
		}
		if endpoint == "" {
			continue
		}
		for _, tld := range service[0] {
			mapping[strings.ToLower(tld)] = endpoint
		}
	}
	return mapping, nil
}
