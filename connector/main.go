package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type allowedUUIDsResponse struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Data    struct {
		NodeID int      `json:"node_id"`
		UUIDs  []string `json:"uuids"`
	} `json:"data"`
}

type config struct {
	PanelBaseURL   string
	InternalToken  string
	NodeIDs        []int
	Interval       time.Duration
	OutputDir      string
	ApplyCommand   string
	ApplyMode      string
	HTTPTimeout    time.Duration
	Once           bool
	FailFast       bool

	// xray gRPC apply
	XrayAPIAddr    string
	XrayTagMap     map[int]string // node_id -> inbound tag
	XrayVlessFlow  string
	XrayRPCTimeout time.Duration

	// traffic reporting
	EnableTrafficReport bool
	TrafficReportInterval time.Duration
}

func env(key, def string) string {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		return def
	}
	return v
}

func parseNodeIDs(s string) ([]int, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil, errors.New("NODE_IDS is empty")
	}
	parts := strings.Split(s, ",")
	var out []int
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		id, err := strconv.Atoi(p)
		if err != nil || id <= 0 {
			return nil, fmt.Errorf("invalid node id: %q", p)
		}
		out = append(out, id)
	}
	if len(out) == 0 {
		return nil, errors.New("no valid node ids")
	}
	return out, nil
}

func ensureDir(dir string) error {
	return os.MkdirAll(dir, 0o755)
}

func sha256Hex(b []byte) string {
	h := sha256.Sum256(b)
	return fmt.Sprintf("%x", h[:])
}

func parseTagMap(raw string) map[int]string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return map[int]string{}
	}
	out := make(map[int]string)
	pairs := strings.Split(raw, ",")
	for _, p := range pairs {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		kv := strings.SplitN(p, ":", 2)
		if len(kv) != 2 {
			continue
		}
		id, err := strconv.Atoi(strings.TrimSpace(kv[0]))
		if err != nil || id <= 0 {
			continue
		}
		tag := strings.TrimSpace(kv[1])
		if tag == "" {
			continue
		}
		out[id] = tag
	}
	return out
}

func inferProtoFromTag(tag string) string {
	t := strings.ToLower(tag)
	switch {
	case strings.Contains(t, "vmess"):
		return "vmess"
	case strings.Contains(t, "vless"):
		return "vless"
	default:
		// 先默认 vless（最常用）
		return "vless"
	}
}

func fetchAllowedUUIDs(ctx context.Context, cfg config, nodeID int) ([]string, error) {
	url := strings.TrimRight(cfg.PanelBaseURL, "/") + fmt.Sprintf("/api/internal/nodes/%d/allowed-uuids", nodeID)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("x-internal-token", cfg.InternalToken)

	client := &http.Client{Timeout: cfg.HTTPTimeout}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("panel status=%d body=%s", resp.StatusCode, string(body))
	}

	var parsed allowedUUIDsResponse
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil, fmt.Errorf("decode json failed: %w; body=%s", err, string(body))
	}
	if parsed.Code != 200 {
		return nil, fmt.Errorf("panel code=%d message=%s", parsed.Code, parsed.Message)
	}
	return parsed.Data.UUIDs, nil
}

// reportTraffic 上报流量到面板
func reportTraffic(ctx context.Context, cfg config, nodeID int, uuid string, upload int64, download int64) error {
	url := strings.TrimRight(cfg.PanelBaseURL, "/") + "/api/internal/report-traffic"
	payload := map[string]interface{}{
		"uuid":      uuid,
		"node_id":   nodeID,
		"upload":    upload,
		"download":  download,
	}
	bodyBytes, _ := json.Marshal(payload)

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(bodyBytes))
	if err != nil {
		return err
	}
	req.Header.Set("x-internal-token", cfg.InternalToken)
	req.Header.Set("Content-Type", "application/json")

	client := &http.Client{Timeout: cfg.HTTPTimeout}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("panel status=%d body=%s", resp.StatusCode, string(body))
	}

	var result struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	}
	body, _ := io.ReadAll(resp.Body)
	if err := json.Unmarshal(body, &result); err == nil && result.Code != 200 {
		return fmt.Errorf("panel code=%d message=%s", result.Code, result.Message)
	}

	return nil
}

// loadTrafficState 加载上次流量状态（用于计算增量）
func loadTrafficState(path string) (map[string]struct {
	Upload   int64 `json:"upload"`
	Download int64 `json:"download"`
}, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return make(map[string]struct {
			Upload   int64 `json:"upload"`
			Download int64 `json:"download"`
		}), nil // 文件不存在时返回空 map
	}

	var state map[string]struct {
		Upload   int64 `json:"upload"`
		Download int64 `json:"download"`
	}
	if err := json.Unmarshal(data, &state); err != nil {
		return nil, err
	}
	return state, nil
}

// saveTrafficState 保存流量状态
func saveTrafficState(path string, state map[string]struct {
	Upload   int64 `json:"upload"`
	Download int64 `json:"download"`
}) error {
	data, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o644)
}

// reportTrafficOnce 上报一次流量（查询 Xray Stats 并上报增量）
func reportTrafficOnce(ctx context.Context, cfg config, nodeID int, tag string) error {
	// 加载 applied.json 获取当前活跃的 UUID 列表
	nodeDir := filepath.Join(cfg.OutputDir, fmt.Sprintf("node-%d", nodeID))
	appliedPath := filepath.Join(nodeDir, "applied.json")
	trafficStatePath := filepath.Join(nodeDir, "traffic-state.json")

	appliedState, err := loadAppliedState(appliedPath)
	if err != nil {
		// applied.json 不存在或为空，跳过
		return nil
	}

	if len(appliedState) == 0 {
		return nil
	}

	// 加载上次流量状态
	prevTraffic, err := loadTrafficState(trafficStatePath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "[WARN] node %d load traffic state failed: %v\n", nodeID, err)
		prevTraffic = make(map[string]struct {
			Upload   int64 `json:"upload"`
			Download int64 `json:"download"`
		})
	}

	// 创建 Xray 客户端
	x := newXrayClient(cfg.XrayAPIAddr, cfg.XrayRPCTimeout, cfg.XrayVlessFlow)

	// 新的流量状态
	newTraffic := make(map[string]struct {
		Upload   int64 `json:"upload"`
		Download int64 `json:"download"`
	})

	// 查询每个 UUID 的流量
	for _, uuid := range appliedState {
		upload, download, err := x.getUserTraffic(ctx, uuid)
		if err != nil {
			fmt.Fprintf(os.Stderr, "[WARN] node %d uuid %s query traffic failed: %v\n", nodeID, uuid, err)
			// 如果查询失败，使用上次的值（避免误报）
			if prev, ok := prevTraffic[uuid]; ok {
				newTraffic[uuid] = prev
			} else {
				newTraffic[uuid] = struct {
					Upload   int64 `json:"upload"`
					Download int64 `json:"download"`
				}{0, 0}
			}
			continue
		}

		newTraffic[uuid] = struct {
			Upload   int64 `json:"upload"`
			Download int64 `json:"download"`
		}{upload, download}

		// 计算增量
		var deltaUpload, deltaDownload int64
		if prev, ok := prevTraffic[uuid]; ok {
			deltaUpload = upload - prev.Upload
			deltaDownload = download - prev.Download
		} else {
			// 第一次查询，增量就是当前值
			deltaUpload = upload
			deltaDownload = download
		}

		// 只上报增量 > 0 的流量
		if deltaUpload > 0 || deltaDownload > 0 {
			if err := reportTraffic(ctx, cfg, nodeID, uuid, deltaUpload, deltaDownload); err != nil {
				fmt.Fprintf(os.Stderr, "[WARN] node %d uuid %s report traffic failed: %v\n", nodeID, uuid, err)
			} else {
				fmt.Printf("[INFO] node %d uuid %s reported traffic: upload=%d download=%d\n", nodeID, uuid, deltaUpload, deltaDownload)
			}
		}
	}

	// 保存新的流量状态
	if err := saveTrafficState(trafficStatePath, newTraffic); err != nil {
		fmt.Fprintf(os.Stderr, "[WARN] node %d save traffic state failed: %v\n", nodeID, err)
	}

	return nil
}

func writeIfChanged(path string, content []byte) (changed bool, err error) {
	existing, readErr := os.ReadFile(path)
	if readErr == nil {
		if bytes.Equal(existing, content) {
			return false, nil
		}
	}
	if err := os.WriteFile(path, content, 0o644); err != nil {
		return false, err
	}
	return true, nil
}

func runApplyCommand(ctx context.Context, cmdTemplate string, nodeID int, uuidsFile string, uuidsJSON string) error {
	if strings.TrimSpace(cmdTemplate) == "" {
		return nil
	}
	// 支持简单变量替换，避免引入模板引擎
	cmd := cmdTemplate
	cmd = strings.ReplaceAll(cmd, "{node_id}", strconv.Itoa(nodeID))
	cmd = strings.ReplaceAll(cmd, "{uuids_file}", uuidsFile)
	cmd = strings.ReplaceAll(cmd, "{uuids_json}", uuidsJSON)

	// 在 Windows / Linux 都尽量可用：交给 shell 解释
	var c *exec.Cmd
	if isWindows() {
		c = exec.CommandContext(ctx, "powershell", "-NoProfile", "-Command", cmd)
	} else {
		c = exec.CommandContext(ctx, "sh", "-lc", cmd)
	}
	c.Stdout = os.Stdout
	c.Stderr = os.Stderr
	return c.Run()
}

func isWindows() bool {
	return strings.Contains(strings.ToLower(os.Getenv("OS")), "windows") || os.PathSeparator == '\\'
}

func syncOnce(ctx context.Context, cfg config, lastHash map[int]string) error {
	if err := ensureDir(cfg.OutputDir); err != nil {
		return err
	}

	for _, nodeID := range cfg.NodeIDs {
		uuids, err := fetchAllowedUUIDs(ctx, cfg, nodeID)
		if err != nil {
			if cfg.FailFast {
				return fmt.Errorf("node %d fetch failed: %w", nodeID, err)
			}
			fmt.Fprintf(os.Stderr, "[WARN] node %d fetch failed: %v\n", nodeID, err)
			continue
		}

		// 规范化：去空、去重、排序
		seen := make(map[string]struct{}, len(uuids))
		var normalized []string
		for _, u := range uuids {
			u = strings.TrimSpace(u)
			if u == "" {
				continue
			}
			if _, ok := seen[u]; ok {
				continue
			}
			seen[u] = struct{}{}
			normalized = append(normalized, u)
		}
		// 简单排序（字典序）
		sortStrings(normalized)

		jsonBytes, _ := json.MarshalIndent(map[string]any{
			"node_id":    nodeID,
			"generated":  time.Now().Format(time.RFC3339),
			"uuids":      normalized,
			"uuids_count": len(normalized),
		}, "", "  ")
		jsonBytes = append(jsonBytes, '\n')

		txtBytes := []byte(strings.Join(normalized, "\n") + "\n")

		nodeDir := filepath.Join(cfg.OutputDir, fmt.Sprintf("node-%d", nodeID))
		if err := ensureDir(nodeDir); err != nil {
			return err
		}

		jsonPath := filepath.Join(nodeDir, "allowed-uuids.json")
		txtPath := filepath.Join(nodeDir, "allowed-uuids.txt")
		appliedPath := filepath.Join(nodeDir, "applied.json")

		hash := sha256Hex(jsonBytes)
		if lastHash[nodeID] == hash {
			continue
		}

		changedJSON, err := writeIfChanged(jsonPath, jsonBytes)
		if err != nil {
			return err
		}
		changedTXT, err := writeIfChanged(txtPath, txtBytes)
		if err != nil {
			return err
		}

		if changedJSON || changedTXT {
			fmt.Printf("[INFO] node %d updated uuids=%d (sha=%s)\n", nodeID, len(normalized), hash[:12])
		}

		// apply（两种模式：shell cmd 或 xray-grpc）
		if cfg.ApplyMode == "xray-grpc" {
			tag := cfg.XrayTagMap[nodeID]
			if tag == "" {
				// 兜底：允许只填一个 inbound tag（单节点场景）
				tag = "in-vless-reality"
			}
			protoName := inferProtoFromTag(tag)

			var prev []string
			if b, err := os.ReadFile(appliedPath); err == nil && len(b) > 0 {
				// loadAppliedState 期望文件存在；这里避免把不存在当错误
				prev, _ = loadAppliedState(appliedPath)
			}

			prevSet := make(map[string]struct{}, len(prev))
			for _, u := range prev {
				prevSet[u] = struct{}{}
			}
			nowSet := make(map[string]struct{}, len(normalized))
			for _, u := range normalized {
				nowSet[u] = struct{}{}
			}

			var toAdd []string
			var toRemove []string
			for u := range nowSet {
				if _, ok := prevSet[u]; !ok {
					toAdd = append(toAdd, u)
				}
			}
			for u := range prevSet {
				if _, ok := nowSet[u]; !ok {
					toRemove = append(toRemove, u)
				}
			}
			sortStrings(toAdd)
			sortStrings(toRemove)

			x := newXrayClient(cfg.XrayAPIAddr, cfg.XrayRPCTimeout, cfg.XrayVlessFlow)
			applyErr := func() error {
				// remove first, then add
				for _, u := range toRemove {
					if err := x.removeUser(ctx, tag, u); err != nil {
						return fmt.Errorf("remove user failed: %w", err)
					}
				}
				for _, u := range toAdd {
					if err := x.addUser(ctx, tag, u, protoName); err != nil {
						return fmt.Errorf("add user failed: %w", err)
					}
				}
				return nil
			}()
			if applyErr != nil {
				if cfg.FailFast {
					return fmt.Errorf("node %d xray-grpc apply failed: %w", nodeID, applyErr)
				}
				fmt.Fprintf(os.Stderr, "[WARN] node %d xray-grpc apply failed: %v\n", nodeID, applyErr)
				// 不更新 lastHash，下一轮继续重试
				continue
			}

			if err := saveAppliedState(appliedPath, nodeID, normalized); err != nil {
				if cfg.FailFast {
					return fmt.Errorf("node %d save applied state failed: %w", nodeID, err)
				}
				fmt.Fprintf(os.Stderr, "[WARN] node %d save applied state failed: %v\n", nodeID, err)
			}
		} else {
			if err := runApplyCommand(ctx, cfg.ApplyCommand, nodeID, txtPath, jsonPath); err != nil {
				if cfg.FailFast {
					return fmt.Errorf("node %d apply failed: %w", nodeID, err)
				}
				fmt.Fprintf(os.Stderr, "[WARN] node %d apply failed: %v\n", nodeID, err)
				// 不更新 lastHash，下一轮继续重试
				continue
			}
		}

		lastHash[nodeID] = hash
	}
	return nil
}

func sortStrings(a []string) {
	// 小项目避免引入 sort 包的额外解释：直接冒泡足够（uuid 列表通常不大）
	n := len(a)
	for i := 0; i < n; i++ {
		for j := 0; j < n-1-i; j++ {
			if a[j] > a[j+1] {
				a[j], a[j+1] = a[j+1], a[j]
			}
		}
	}
}

func main() {
	var (
		flagOnce     = flag.Bool("once", false, "run once and exit")
		flagFailFast = flag.Bool("fail-fast", false, "exit on first error")
	)
	flag.Parse()

	panel := env("PANEL_BASE_URL", "http://localhost:3000")
	token := env("INTERNAL_API_KEY", "")
	nodeIDsStr := env("NODE_IDS", "")
	outDir := env("OUTPUT_DIR", "./out")
	applyCmd := env("APPLY_CMD", "")
	applyMode := env("APPLY_MODE", "")
	intervalSec := env("INTERVAL_SECONDS", "10")
	httpTimeoutSec := env("HTTP_TIMEOUT_SECONDS", "10")
	xrayAPIAddr := env("XRAY_API_ADDR", "127.0.0.1:10085")
	xrayTagMapRaw := env("XRAY_TAG_MAP", "")
	xrayVlessFlow := env("XRAY_VLESS_FLOW", "xtls-rprx-vision")
	xrayRPCTimeoutSec := env("XRAY_RPC_TIMEOUT_SECONDS", "5")
	enableTrafficReport := env("ENABLE_TRAFFIC_REPORT", "true")
	trafficReportIntervalSec := env("TRAFFIC_REPORT_INTERVAL_SECONDS", "60")

	if token == "" {
		fmt.Fprintln(os.Stderr, "INTERNAL_API_KEY is empty (env). It must match backend .env.docker INTERNAL_API_KEY and be sent as x-internal-token.")
		os.Exit(2)
	}

	nodeIDs, err := parseNodeIDs(nodeIDsStr)
	if err != nil {
		fmt.Fprintf(os.Stderr, "NODE_IDS parse failed: %v\n", err)
		os.Exit(2)
	}

	sec, _ := strconv.Atoi(intervalSec)
	if sec <= 0 {
		sec = 10
	}
	tsec, _ := strconv.Atoi(httpTimeoutSec)
	if tsec <= 0 {
		tsec = 10
	}
	rpcSec, _ := strconv.Atoi(xrayRPCTimeoutSec)
	if rpcSec <= 0 {
		rpcSec = 5
	}

	if strings.TrimSpace(applyMode) == "" {
		if strings.TrimSpace(applyCmd) != "" {
			applyMode = "cmd"
		} else {
			applyMode = "none"
		}
	}

	enableTraffic := strings.ToLower(enableTrafficReport) == "true"
	trafficSec, _ := strconv.Atoi(trafficReportIntervalSec)
	if trafficSec <= 0 {
		trafficSec = 60 // 默认 60 秒
	}

	cfg := config{
		PanelBaseURL:  panel,
		InternalToken: token,
		NodeIDs:       nodeIDs,
		Interval:      time.Duration(sec) * time.Second,
		OutputDir:     outDir,
		ApplyCommand:  applyCmd,
		ApplyMode:     applyMode,
		HTTPTimeout:   time.Duration(tsec) * time.Second,
		Once:          *flagOnce,
		FailFast:      *flagFailFast,

		XrayAPIAddr:    xrayAPIAddr,
		XrayTagMap:     parseTagMap(xrayTagMapRaw),
		XrayVlessFlow:  xrayVlessFlow,
		XrayRPCTimeout: time.Duration(rpcSec) * time.Second,

		EnableTrafficReport:  enableTraffic,
		TrafficReportInterval: time.Duration(trafficSec) * time.Second,
	}

	fmt.Printf("[INFO] connector started panel=%s nodes=%v interval=%s out=%s\n", cfg.PanelBaseURL, cfg.NodeIDs, cfg.Interval, cfg.OutputDir)
	if cfg.ApplyMode == "xray-grpc" {
		fmt.Printf("[INFO] apply mode: xray-grpc api=%s vless_flow=%s\n", cfg.XrayAPIAddr, cfg.XrayVlessFlow)
		if len(cfg.XrayTagMap) > 0 {
			fmt.Printf("[INFO] xray tag map: %v\n", cfg.XrayTagMap)
		} else {
			fmt.Printf("[WARN] XRAY_TAG_MAP is empty; default inbound tag will be used: in-vless-reality\n")
		}
	} else if cfg.ApplyCommand != "" {
		fmt.Printf("[INFO] apply command enabled: %s\n", cfg.ApplyCommand)
	}
	if cfg.EnableTrafficReport {
		fmt.Printf("[INFO] traffic reporting enabled: interval=%s\n", cfg.TrafficReportInterval)
	}

	lastHash := make(map[int]string)
	ctx := context.Background()

	if cfg.Once {
		if err := syncOnce(ctx, cfg, lastHash); err != nil {
			fmt.Fprintf(os.Stderr, "sync failed: %v\n", err)
			os.Exit(1)
		}
		return
	}

	syncTicker := time.NewTicker(cfg.Interval)
	defer syncTicker.Stop()

	var trafficTicker *time.Ticker
	if cfg.EnableTrafficReport && cfg.ApplyMode == "xray-grpc" {
		trafficTicker = time.NewTicker(cfg.TrafficReportInterval)
		defer trafficTicker.Stop()
		// 立即执行一次流量上报（延迟 5 秒，等待 Xray 启动）
		go func() {
			time.Sleep(5 * time.Second)
			for _, nodeID := range cfg.NodeIDs {
				tag := cfg.XrayTagMap[nodeID]
				if tag == "" {
					tag = "in-vless-reality"
				}
				if err := reportTrafficOnce(ctx, cfg, nodeID, tag); err != nil {
					fmt.Fprintf(os.Stderr, "[WARN] node %d initial traffic report failed: %v\n", nodeID, err)
				}
			}
		}()
	}

	for {
		select {
		case <-syncTicker.C:
			if err := syncOnce(ctx, cfg, lastHash); err != nil {
				fmt.Fprintf(os.Stderr, "sync failed: %v\n", err)
				if cfg.FailFast {
					os.Exit(1)
				}
			}
		case <-trafficTicker.C:
			if cfg.EnableTrafficReport && cfg.ApplyMode == "xray-grpc" {
				for _, nodeID := range cfg.NodeIDs {
					tag := cfg.XrayTagMap[nodeID]
					if tag == "" {
						tag = "in-vless-reality"
					}
					if err := reportTrafficOnce(ctx, cfg, nodeID, tag); err != nil {
						fmt.Fprintf(os.Stderr, "[WARN] node %d traffic report failed: %v\n", nodeID, err)
					}
				}
			}
		}
	}
}

