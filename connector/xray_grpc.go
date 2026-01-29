package main

import (
	"context"
	"fmt"
	"strings"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	command "github.com/xtls/xray-core/app/proxyman/command"
	stats "github.com/xtls/xray-core/app/stats/command"
	"github.com/xtls/xray-core/common/protocol"
	"github.com/xtls/xray-core/common/serial"
	"github.com/xtls/xray-core/proxy/vless"
	"github.com/xtls/xray-core/proxy/vmess"
)

type xrayClient struct {
	addr      string
	timeout   time.Duration
	vlessFlow string
}

func isXrayAlreadyExistsErr(err error) bool {
	if err == nil {
		return false
	}
	// Xray 有时会返回 gRPC Unknown + desc 中带业务错误文本
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "already exists") || strings.Contains(msg, "already exist")
}

func isXrayNotFoundErr(err error) bool {
	if err == nil {
		return false
	}
	msg := strings.ToLower(err.Error())
	// 兼容不同版本/实现的文案
	return strings.Contains(msg, "not found") ||
		strings.Contains(msg, "does not exist") ||
		strings.Contains(msg, "no such user")
}

func newXrayClient(addr string, timeout time.Duration, vlessFlow string) *xrayClient {
	if strings.TrimSpace(addr) == "" {
		addr = "127.0.0.1:10085"
	}
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	if strings.TrimSpace(vlessFlow) == "" {
		vlessFlow = "xtls-rprx-vision"
	}
	return &xrayClient{addr: addr, timeout: timeout, vlessFlow: vlessFlow}
}

func (c *xrayClient) dial(ctx context.Context) (*grpc.ClientConn, error) {
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()
	return grpc.DialContext(ctx, c.addr, grpc.WithTransportCredentials(insecure.NewCredentials()))
}

func (c *xrayClient) addUser(ctx context.Context, inboundTag string, uuid string, protoName string) error {
	conn, err := c.dial(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()

	client := command.NewHandlerServiceClient(conn)

	user, err := c.buildUser(uuid, protoName)
	if err != nil {
		return err
	}
	op := &command.AddUserOperation{User: user}
	_, err = client.AlterInbound(ctx, &command.AlterInboundRequest{
		Tag:       inboundTag,
		Operation: serial.ToTypedMessage(op),
	})
	if err != nil && isXrayAlreadyExistsErr(err) {
		// 幂等：用户已存在，视为成功（避免因 applied.json 被清掉导致无法恢复）
		return nil
	}
	return err
}

func (c *xrayClient) removeUser(ctx context.Context, inboundTag string, email string) error {
	conn, err := c.dial(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()

	client := command.NewHandlerServiceClient(conn)
	op := &command.RemoveUserOperation{Email: email}
	_, err = client.AlterInbound(ctx, &command.AlterInboundRequest{
		Tag:       inboundTag,
		Operation: serial.ToTypedMessage(op),
	})
	if err != nil && isXrayNotFoundErr(err) {
		// 幂等：本就不存在，视为成功
		return nil
	}
	return err
}

func (c *xrayClient) buildUser(uuid string, protoName string) (*protocol.User, error) {
	protoName = strings.ToLower(strings.TrimSpace(protoName))
	email := uuid // 用 uuid 作为稳定 email，便于 RemoveUser

	switch protoName {
	case "vless":
		acc := &vless.Account{
			Id:         uuid,
			Encryption: "none",
			Flow:       c.vlessFlow,
		}
		return &protocol.User{
			Level:   0,
			Email:   email,
			Account: serial.ToTypedMessage(acc),
		}, nil
	case "vmess":
		acc := &vmess.Account{
			Id: uuid,
		}
		return &protocol.User{
			Level:   0,
			Email:   email,
			Account: serial.ToTypedMessage(acc),
		}, nil
	default:
		return nil, fmt.Errorf("unsupported proto for grpc add/remove: %s", protoName)
	}
}

// getUserTraffic 查询指定用户的流量（通过 email/UUID）
// 返回 upload, download（字节数）
func (c *xrayClient) getUserTraffic(ctx context.Context, email string) (upload int64, download int64, err error) {
	conn, err := c.dial(ctx)
	if err != nil {
		return 0, 0, err
	}
	defer conn.Close()

	client := stats.NewStatsServiceClient(conn)

	// 查询 uplink 流量：Xray 官方格式为 user>>>email>>>traffic>>>uplink
	uplinkResp, err := client.QueryStats(ctx, &stats.QueryStatsRequest{
		Pattern: fmt.Sprintf("user>>>%s>>>traffic>>>uplink", email),
		Reset_:   false, // 不重置，只查询
	})
	if err != nil {
		return 0, 0, fmt.Errorf("query uplink failed: %w", err)
	}

	// 查询 downlink 流量：user>>>email>>>traffic>>>downlink
	downlinkResp, err := client.QueryStats(ctx, &stats.QueryStatsRequest{
		Pattern: fmt.Sprintf("user>>>%s>>>traffic>>>downlink", email),
		Reset_:  false, // 不重置，只查询
	})
	if err != nil {
		return 0, 0, fmt.Errorf("query downlink failed: %w", err)
	}

	upload = int64(0)
	download = int64(0)

	// 解析 uplink 响应
	if len(uplinkResp.Stat) > 0 {
		upload = uplinkResp.Stat[0].Value
	}

	// 解析 downlink 响应
	if len(downlinkResp.Stat) > 0 {
		download = downlinkResp.Stat[0].Value
	}

	return upload, download, nil
}

