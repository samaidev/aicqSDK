package aicq

import (
	"fmt"
)

// ─── Error Types ─────────────────────────────────────────────────
// All SDKs MUST define AICQError, AuthError, and ConnectionError.
// All HTTP errors MUST include: HTTP status code, server error message, endpoint.

// AICQError is the base error type for all SDK errors.
type AICQError struct {
	Message string `json:"message"`
}

func (e *AICQError) Error() string {
	return fmt.Sprintf("aicq: %s", e.Message)
}

// NewAICQError creates a new AICQError.
func NewAICQError(msg string) *AICQError {
	return &AICQError{Message: msg}
}

// AuthError represents authentication failures.
// Includes the HTTP status code and the endpoint that failed.
type AuthError struct {
	StatusCode int    `json:"status_code"`
	Message    string `json:"message"`
	Endpoint   string `json:"endpoint"`
}

func (e *AuthError) Error() string {
	if e.StatusCode > 0 {
		return fmt.Sprintf("auth error (HTTP %d, %s): %s", e.StatusCode, e.Endpoint, e.Message)
	}
	return fmt.Sprintf("auth error: %s", e.Message)
}

// NewAuthError creates a new AuthError.
func NewAuthError(statusCode int, message, endpoint string) *AuthError {
	return &AuthError{StatusCode: statusCode, Message: message, Endpoint: endpoint}
}

// ConnectionError represents WebSocket/network failures.
type ConnectionError struct {
	Message string `json:"message"`
	Retry   bool   `json:"retry,omitempty"`
}

func (e *ConnectionError) Error() string {
	retryStr := ""
	if e.Retry {
		retryStr = " (retry possible)"
	}
	return fmt.Sprintf("connection error%s: %s", retryStr, e.Message)
}

// NewConnectionError creates a new ConnectionError.
func NewConnectionError(message string, retry bool) *ConnectionError {
	return &ConnectionError{Message: message, Retry: retry}
}

// HTTPError represents an HTTP error response from the server.
// Includes the status code, body, and endpoint for debugging.
type HTTPError struct {
	StatusCode int    `json:"status_code"`
	Body       string `json:"body"`
	Endpoint   string `json:"endpoint"`
}

func (e *HTTPError) Error() string {
	body := e.Body
	if len(body) > 300 {
		body = body[:300] + "..."
	}
	return fmt.Sprintf("HTTP %d %s: %s", e.StatusCode, e.Endpoint, body)
}

// NewHTTPError creates a new HTTPError.
func NewHTTPError(statusCode int, body, endpoint string) *HTTPError {
	return &HTTPError{StatusCode: statusCode, Body: body, Endpoint: endpoint}
}
