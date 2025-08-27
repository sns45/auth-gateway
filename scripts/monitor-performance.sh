#!/bin/bash

# Performance Monitoring Script for Auth Gateway
# This script helps monitor the auth gateway performance and health

set -e

echo "🔍 Auth Gateway Performance Monitor"
echo "==================================="
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
STAGING_URL="https://auth-staging.example.com"
PROD_URL="https://auth.example.com"
CHECK_INTERVAL=5  # seconds between checks
DURATION=60       # total monitoring duration in seconds

# Function to check endpoint performance
check_endpoint() {
    local url=$1
    local endpoint=$2
    local env=$3
    
    # Measure response time
    start_time=$(date +%s.%N)
    response=$(curl -s -o /dev/null -w "%{http_code}|%{time_total}|%{size_download}" "$url$endpoint" 2>/dev/null || echo "000|0|0")
    end_time=$(date +%s.%N)
    
    # Parse response
    http_code=$(echo $response | cut -d'|' -f1)
    time_total=$(echo $response | cut -d'|' -f2)
    size_download=$(echo $response | cut -d'|' -f3)
    
    # Color code based on response time
    if [ "$http_code" = "200" ] || [ "$http_code" = "204" ]; then
        if (( $(echo "$time_total < 0.1" | bc -l) )); then
            color=$GREEN
            status="FAST"
        elif (( $(echo "$time_total < 0.5" | bc -l) )); then
            color=$YELLOW
            status="OK"
        else
            color=$RED
            status="SLOW"
        fi
    else
        color=$RED
        status="ERROR"
    fi
    
    # Print result
    printf "[%s] %s%-6s%s | %-25s | HTTP %3s | %7.3fs | %6s bytes\n" \
        "$(date +%H:%M:%S)" "$color" "$status" "$NC" "$env$endpoint" \
        "$http_code" "$time_total" "$size_download"
}

# Function to run performance test
run_performance_test() {
    local env=$1
    local url=$2
    
    echo -e "\n${BLUE}Testing $env environment: $url${NC}"
    echo "----------------------------------------"
    
    # Test various endpoints
    check_endpoint "$url" "/health" "$env"
    check_endpoint "$url" "/api/auth/session" "$env"
    check_endpoint "$url" "/api/auth/signin/google" "$env"
    
    # Measure rate limiting
    echo -e "\n${YELLOW}Rate Limit Test:${NC}"
    for i in {1..12}; do
        response=$(curl -s -o /dev/null -w "%{http_code}" -H "X-Test-Run: perf-test-$$" "$url/api/auth/session")
        if [ "$response" = "429" ]; then
            echo -e "${RED}Rate limited at request #$i${NC}"
            break
        fi
    done
    
    if [ "$response" != "429" ]; then
        echo -e "${GREEN}No rate limiting triggered (12 requests)${NC}"
    fi
}

# Function to monitor real-time logs
monitor_logs() {
    echo -e "\n${BLUE}📊 Real-time Log Monitoring${NC}"
    echo "Press Ctrl+C to stop monitoring"
    echo ""
    
    # Start log tailing in background
    wrangler tail --config config/wrangler.toml --format=json | while read -r line; do
        # Parse JSON log
        if echo "$line" | jq -e . >/dev/null 2>&1; then
            timestamp=$(echo "$line" | jq -r '.timestamp // "unknown"')
            level=$(echo "$line" | jq -r '.level // "info"')
            message=$(echo "$line" | jq -r '.message // ""')
            duration=$(echo "$line" | jq -r '.duration // 0')
            
            # Color based on log level
            case "$level" in
                "error") color=$RED ;;
                "warn") color=$YELLOW ;;
                "info") color=$BLUE ;;
                *) color=$NC ;;
            esac
            
            # Format output
            printf "[%s] %s%-5s%s %s" "$timestamp" "$color" "$level" "$NC" "$message"
            
            # Add duration if available
            if [ "$duration" != "0" ] && [ "$duration" != "null" ]; then
                printf " (%.3fms)" "$duration"
            fi
            
            echo ""
        fi
    done
}

# Function to generate performance report
generate_report() {
    local env=$1
    local url=$2
    
    echo -e "\n${BLUE}📈 Performance Report - $env${NC}"
    echo "================================"
    
    # Run 10 requests and calculate statistics
    total_time=0
    success_count=0
    
    for i in {1..10}; do
        response=$(curl -s -o /dev/null -w "%{http_code}|%{time_total}" "$url/health")
        http_code=$(echo $response | cut -d'|' -f1)
        time_total=$(echo $response | cut -d'|' -f2)
        
        if [ "$http_code" = "200" ]; then
            ((success_count++))
            total_time=$(echo "$total_time + $time_total" | bc)
        fi
        
        sleep 0.1
    done
    
    # Calculate average
    if [ $success_count -gt 0 ]; then
        avg_time=$(echo "scale=3; $total_time / $success_count" | bc)
        success_rate=$(echo "scale=1; $success_count * 10" | bc)
        
        echo "Success Rate: ${success_rate}%"
        echo "Average Response Time: ${avg_time}s"
        
        # Performance grade
        if (( $(echo "$avg_time < 0.05" | bc -l) )); then
            grade="A+"
            grade_color=$GREEN
        elif (( $(echo "$avg_time < 0.1" | bc -l) )); then
            grade="A"
            grade_color=$GREEN
        elif (( $(echo "$avg_time < 0.2" | bc -l) )); then
            grade="B"
            grade_color=$YELLOW
        else
            grade="C"
            grade_color=$RED
        fi
        
        echo -e "Performance Grade: ${grade_color}${grade}${NC}"
    else
        echo -e "${RED}All requests failed!${NC}"
    fi
}

# Main monitoring loop
main() {
    # Check if environments are specified
    environments=("staging")
    if [ "$1" = "all" ] || [ "$1" = "production" ]; then
        environments=("staging" "production")
    fi
    
    # Continuous monitoring mode
    if [ "$2" = "monitor" ]; then
        monitor_logs
        exit 0
    fi
    
    # Performance testing mode
    echo -e "${BLUE}🚀 Starting Performance Tests${NC}"
    echo "Duration: ${DURATION}s | Interval: ${CHECK_INTERVAL}s"
    echo ""
    
    start_time=$(date +%s)
    iteration=0
    
    while true; do
        current_time=$(date +%s)
        elapsed=$((current_time - start_time))
        
        if [ $elapsed -ge $DURATION ]; then
            break
        fi
        
        echo -e "\n${YELLOW}=== Iteration $((++iteration)) ===${NC}"
        
        for env in "${environments[@]}"; do
            if [ "$env" = "staging" ]; then
                run_performance_test "Staging" "$STAGING_URL"
            else
                run_performance_test "Production" "$PROD_URL"
            fi
        done
        
        sleep $CHECK_INTERVAL
    done
    
    # Generate final reports
    echo -e "\n${BLUE}📊 Final Performance Reports${NC}"
    echo "============================"
    
    for env in "${environments[@]}"; do
        if [ "$env" = "staging" ]; then
            generate_report "Staging" "$STAGING_URL"
        else
            generate_report "Production" "$PROD_URL"
        fi
    done
    
    echo -e "\n${GREEN}✅ Monitoring complete!${NC}"
}

# Show usage
if [ "$1" = "help" ] || [ "$1" = "--help" ]; then
    echo "Usage: $0 [environment] [mode]"
    echo ""
    echo "Environments:"
    echo "  staging    - Monitor staging environment only (default)"
    echo "  production - Monitor production environment only"
    echo "  all        - Monitor both environments"
    echo ""
    echo "Modes:"
    echo "  (default)  - Run performance tests"
    echo "  monitor    - Real-time log monitoring"
    echo ""
    echo "Examples:"
    echo "  $0                    # Test staging environment"
    echo "  $0 all                # Test all environments"
    echo "  $0 staging monitor    # Monitor staging logs"
    exit 0
fi

# Run main function
main "$@"