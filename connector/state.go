package main

import (
	"encoding/json"
	"os"
	"time"
)

type appliedState struct {
	NodeID    int      `json:"node_id"`
	UpdatedAt string   `json:"updated_at"`
	UUIDs     []string `json:"uuids"`
}

func loadAppliedState(path string) ([]string, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var st appliedState
	if err := json.Unmarshal(b, &st); err != nil {
		return nil, err
	}
	return st.UUIDs, nil
}

func saveAppliedState(path string, nodeID int, uuids []string) error {
	st := appliedState{
		NodeID:    nodeID,
		UpdatedAt: time.Now().Format(time.RFC3339),
		UUIDs:     uuids,
	}
	b, err := json.MarshalIndent(st, "", "  ")
	if err != nil {
		return err
	}
	b = append(b, '\n')
	return os.WriteFile(path, b, 0o644)
}

