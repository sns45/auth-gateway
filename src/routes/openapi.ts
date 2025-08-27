import { Hono } from 'hono';
import type { CloudflareEnv } from '@/types/auth';
import type { Variables } from '@/types/context';

const openApiRoutes = new Hono<{ Bindings: CloudflareEnv; Variables: Variables }>();

// OpenAPI YAML specification embedded as a string
const openApiSpec = `openapi: 3.0.0
info:
  title: Authentication Gateway API
  description: |
    Central authentication gateway service using Cloudflare Workers, KV storage, and Convex for real-time session management.
    
    ## Architecture
    - **Auth Gateway**: Cloudflare Workers handling OAuth and session management
    - **Session Storage**: KV storage with Convex fallback for high availability
    - **Real-time Sync**: Convex provides WebSocket-based session synchronization
    
    ## Security Notice
    This API handles sensitive authentication operations. When developing clients:
    - Always use HTTPS in production
    - Session IDs stored in both httpOnly and non-httpOnly cookies
    - Multi-tab synchronization via Convex WebSocket
    - KV storage limits handled with automatic Convex fallback
    - OAuth state parameter for CSRF protection
    
  version: 1.0.0
  contact:
    name: Platform Team
    email: support@example.com
  license:
    name: MIT
    url: https://opensource.org/licenses/MIT

servers:
  - url: https://auth.example.com
    description: Production server
  - url: https://auth-staging.example.com
    description: Staging server
  - url: http://localhost:8787
    description: Local development

tags:
  - name: Health
    description: Health check endpoints
  - name: Authentication
    description: Authentication operations
  - name: OAuth
    description: OAuth provider operations
  - name: Session
    description: Session management
  - name: User
    description: User operations
  - name: Better Auth
    description: Better Auth proxy endpoints
  - name: WebSocket
    description: WebSocket real-time communication
  - name: Convex Protocol
    description: Convex sync and function endpoints
  - name: Proxy
    description: API proxy endpoints

paths:
  /:
    get:
      summary: Get API information
      description: Returns basic information about the API
      tags:
        - Health
      responses:
        '200':
          description: API information
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ApiInfo'

  /health:
    get:
      summary: Health check
      description: Returns the health status of the service
      tags:
        - Health
      responses:
        '200':
          description: Service is healthy
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/HealthCheck'
        '503':
          description: Service is unhealthy
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/HealthCheck'

  /api/auth/signin/{provider}:
    post:
      summary: Initiate OAuth sign-in
      description: |
        Initiates OAuth authentication flow with specified provider.
        Returns authorization URL for client-side redirect.
      tags:
        - OAuth
      parameters:
        - name: provider
          in: path
          required: true
          description: OAuth provider name
          schema:
            type: string
            enum: [google, github, discord]
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required:
                - callbackURL
              properties:
                callbackURL:
                  type: string
                  format: uri
                  description: URL to redirect after OAuth completion
                  example: "https://app.example.com/auth/callback"
                state:
                  type: string
                  description: Optional state parameter for CSRF protection
      responses:
        '200':
          description: OAuth URL generated successfully
          content:
            application/json:
              schema:
                type: object
                properties:
                  url:
                    type: string
                    format: uri
                    description: OAuth authorization URL
                  state:
                    type: string
                    description: State parameter for verification
        '400':
          $ref: '#/components/responses/BadRequest'
        '429':
          $ref: '#/components/responses/RateLimited'

  /api/auth/callback/{provider}:
    get:
      summary: OAuth callback handler
      description: |
        Handles OAuth provider callbacks. This endpoint is typically called
        by the OAuth provider, not directly by clients.
      tags:
        - OAuth
      parameters:
        - name: provider
          in: path
          required: true
          schema:
            type: string
            enum: [google, github, discord]
        - name: code
          in: query
          required: true
          schema:
            type: string
          description: Authorization code from OAuth provider
        - name: state
          in: query
          required: true
          schema:
            type: string
          description: State parameter for CSRF protection
      responses:
        '302':
          description: Redirect to callback URL with tokens
          headers:
            Location:
              schema:
                type: string
              description: Redirect URL with tokens
            Set-Cookie:
              schema:
                type: string
              description: Session cookie
        '400':
          $ref: '#/components/responses/BadRequest'
        '401':
          $ref: '#/components/responses/Unauthorized'

  /api/auth/signout:
    post:
      summary: Sign out user
      description: Invalidates the current session and clears authentication
      tags:
        - Authentication
      security:
        - cookieAuth: []
        - bearerAuth: []
      responses:
        '200':
          description: Successfully signed out
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/SuccessResponse'
        '401':
          $ref: '#/components/responses/Unauthorized'

  /api/auth/session:
    get:
      summary: Get current session
      description: Returns information about the current authenticated session
      tags:
        - Session
      security:
        - cookieAuth: []
        - bearerAuth: []
      responses:
        '200':
          description: Session information
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/SessionInfo'
        '401':
          $ref: '#/components/responses/Unauthorized'

  /api/auth/refresh:
    post:
      summary: Refresh access token
      description: |
        Refreshes an expired access token using a valid refresh token.
        Requires either a refresh token in the request body or a valid session cookie.
      tags:
        - Authentication
      requestBody:
        content:
          application/json:
            schema:
              type: object
              properties:
                refreshToken:
                  type: string
                  description: Refresh token (optional if using cookies)
      responses:
        '200':
          description: New tokens generated
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/TokenResponse'
        '401':
          $ref: '#/components/responses/Unauthorized'

  /api/ws:
    get:
      summary: WebSocket connection endpoint
      description: |
        Establishes a WebSocket connection for real-time communication with Convex backend.
        Supports Convex protocol for sync operations, queries, and mutations.
        
        ## WebSocket Protocol
        - Send JSON messages with \`type\` field indicating message type
        - Supports Convex sync protocol with binary optimization
        - Authentication context is automatically added to messages
        - Heartbeat/ping-pong for connection health
        
        ## Supported Message Types
        - \`Connect\`: Initialize connection with session info
        - \`Add\`: Subscribe to queries
        - \`Remove\`: Unsubscribe from queries
        - \`Mutation\`: Execute mutations
        - \`Action\`: Execute actions
        - \`Authenticate\`: Update authentication state
      tags:
        - WebSocket
        - Convex Protocol
      security:
        - cookieAuth: []
        - bearerAuth: []
      parameters:
        - name: Upgrade
          in: header
          required: true
          description: Must be 'websocket'
          schema:
            type: string
            enum: [websocket]
        - name: Connection
          in: header
          required: true
          description: Must be 'Upgrade'
          schema:
            type: string
            enum: [Upgrade]
        - name: Sec-WebSocket-Key
          in: header
          required: true
          description: WebSocket key for handshake
          schema:
            type: string
        - name: Sec-WebSocket-Version
          in: header
          required: true
          description: WebSocket protocol version
          schema:
            type: string
            enum: ['13']
        - name: Sec-WebSocket-Protocol
          in: header
          required: false
          description: Optional WebSocket sub-protocols
          schema:
            type: string
            example: "convex-sync"
      responses:
        '101':
          description: Switching Protocols - WebSocket connection established
          headers:
            Upgrade:
              schema:
                type: string
                example: websocket
            Connection:
              schema:
                type: string
                example: Upgrade
            Sec-WebSocket-Accept:
              schema:
                type: string
              description: WebSocket accept key
        '400':
          description: Bad Request - Invalid WebSocket upgrade request
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
              example:
                success: false
                error:
                  message: "WebSocket upgrade required"
                  code: "INVALID_REQUEST"
        '401':
          $ref: '#/components/responses/Unauthorized'
        '500':
          description: WebSocket service error
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'

  /api/auth/{path+}:
    get:
      summary: Better Auth proxy - GET requests
      description: |
        Proxies Better Auth requests to Convex backend. 
        Handles session management, OAuth flows, and user authentication.
        
        ## Common Better Auth Endpoints
        - \`/api/auth/get-session\` - Get current session
        - \`/api/auth/sign-in/social\` - Social sign-in
        - \`/api/auth/sign-out\` - Sign out
        - \`/api/auth/callback/[provider]\` - OAuth callbacks
      tags:
        - Better Auth
      parameters:
        - name: path
          in: path
          required: true
          description: Better Auth endpoint path
          schema:
            type: string
            example: "get-session"
      responses:
        '200':
          description: Successful Better Auth response
          content:
            application/json:
              schema:
                type: object
            text/html:
              schema:
                type: string
                description: HTML response for certain endpoints
        '302':
          description: Redirect response for OAuth flows
          headers:
            Location:
              schema:
                type: string
              description: Redirect URL
            Set-Cookie:
              schema:
                type: string
              description: Session cookies
        '400':
          $ref: '#/components/responses/BadRequest'
        '401':
          $ref: '#/components/responses/Unauthorized'
        '500':
          $ref: '#/components/responses/BadGateway'

    post:
      summary: Better Auth proxy - POST requests
      description: Proxies Better Auth POST requests (sign-in, sign-up, etc.)
      tags:
        - Better Auth
      parameters:
        - name: path
          in: path
          required: true
          schema:
            type: string
      requestBody:
        content:
          application/json:
            schema:
              type: object
          application/x-www-form-urlencoded:
            schema:
              type: object
      responses:
        '200':
          description: Successful Better Auth response
        '302':
          description: Redirect response
        '400':
          $ref: '#/components/responses/BadRequest'
        '500':
          $ref: '#/components/responses/BadGateway'

    put:
      summary: Better Auth proxy - PUT requests
      description: Proxies Better Auth PUT requests
      tags:
        - Better Auth
      parameters:
        - name: path
          in: path
          required: true
          schema:
            type: string
      requestBody:
        content:
          application/json:
            schema:
              type: object
      responses:
        '200':
          description: Successful response
        '400':
          $ref: '#/components/responses/BadRequest'
        '500':
          $ref: '#/components/responses/BadGateway'

    delete:
      summary: Better Auth proxy - DELETE requests
      description: Proxies Better Auth DELETE requests
      tags:
        - Better Auth
      parameters:
        - name: path
          in: path
          required: true
          schema:
            type: string
      responses:
        '200':
          description: Successful response
        '400':
          $ref: '#/components/responses/BadRequest'
        '500':
          $ref: '#/components/responses/BadGateway'

  /api/sync:
    get:
      summary: Convex sync protocol endpoint
      description: |
        WebSocket endpoint for Convex real-time synchronization.
        This endpoint should be accessed via WebSocket upgrade.
        
        ## Convex Sync Protocol
        - Binary-optimized message format
        - Query subscriptions and real-time updates
        - Mutation and action execution
        - Connection state management with versioning
      tags:
        - Convex Protocol
        - WebSocket
      security:
        - cookieAuth: []
        - bearerAuth: []
      parameters:
        - name: Upgrade
          in: header
          required: true
          schema:
            type: string
            enum: [websocket]
      responses:
        '101':
          description: WebSocket connection established for Convex sync
        '400':
          description: Invalid sync request
          content:
            text/plain:
              schema:
                type: string
                example: "Sync endpoint requires WebSocket upgrade"

  /api/function/{functionPath+}:
    post:
      summary: Execute Convex function
      description: |
        Execute Convex functions (queries, mutations, actions) via HTTP.
        Supports binary data and JSON payloads.
        
        ## Function Types
        - **Queries**: Read-only operations that can be cached
        - **Mutations**: Write operations that modify database state
        - **Actions**: Complex operations that can call external APIs
      tags:
        - Convex Protocol
      security:
        - cookieAuth: []
        - bearerAuth: []
      parameters:
        - name: functionPath
          in: path
          required: true
          description: Convex function path (e.g., 'messages/list' or 'users/create')
          schema:
            type: string
            example: "messages/list"
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              properties:
                args:
                  type: array
                  description: Function arguments
                  example: [{"limit": 10}]
                format:
                  type: string
                  enum: ["json", "convex_encoded_json"]
                  description: Argument format
                  default: "json"
            example:
              args: [{"limit": 10, "cursor": null}]
              format: "json"
          application/x-protobuf:
            schema:
              type: string
              format: binary
              description: Binary-encoded Convex protocol data
      responses:
        '200':
          description: Function executed successfully
          content:
            application/json:
              schema:
                type: object
                properties:
                  success:
                    type: boolean
                    example: true
                  result:
                    type: object
                    description: Function result
                  logLines:
                    type: array
                    items:
                      type: string
                    description: Function execution logs
                example:
                  success: true
                  result: [{"_id": "k17...", "text": "Hello"}]
                  logLines: []
            application/x-protobuf:
              schema:
                type: string
                format: binary
        '400':
          $ref: '#/components/responses/BadRequest'
        '401':
          $ref: '#/components/responses/Unauthorized'
        '500':
          $ref: '#/components/responses/BadGateway'

    get:
      summary: Execute Convex query via GET
      description: |
        Execute read-only Convex queries via GET request.
        Arguments are passed as query parameters.
      tags:
        - Convex Protocol
      security:
        - cookieAuth: []
        - bearerAuth: []
      parameters:
        - name: functionPath
          in: path
          required: true
          schema:
            type: string
        - name: args
          in: query
          description: JSON-encoded function arguments
          schema:
            type: string
            example: '{"limit": 10}'
        - name: format
          in: query
          description: Response format
          schema:
            type: string
            enum: ["json", "convex_encoded_json"]
            default: "json"
      responses:
        '200':
          description: Query executed successfully
          content:
            application/json:
              schema:
                type: object
        '400':
          $ref: '#/components/responses/BadRequest'
        '401':
          $ref: '#/components/responses/Unauthorized'
        '500':
          $ref: '#/components/responses/BadGateway'

  /api/v1.0.0/sync:
    get:
      summary: Versioned Convex sync protocol endpoint  
      description: |
        Versioned WebSocket endpoint for Convex real-time synchronization.
        This is the official Convex sync endpoint with version specification.
        
        ## Protocol Version
        - Uses Convex protocol version 1.0.0
        - Binary-optimized for performance
        - Maintains backward compatibility
        
        ## Usage
        Connect via WebSocket with proper authentication headers.
        The connection will be upgraded to WebSocket protocol.
      tags:
        - Convex Protocol
        - WebSocket
      security:
        - cookieAuth: []
        - bearerAuth: []
      parameters:
        - name: Upgrade
          in: header
          required: true
          schema:
            type: string
            enum: [websocket]
        - name: Sec-WebSocket-Protocol
          in: header
          required: false
          description: Convex sync protocol
          schema:
            type: string
            example: "convex-sync-v1"
      responses:
        '101':
          description: WebSocket connection established for versioned Convex sync
          headers:
            Sec-WebSocket-Protocol:
              schema:
                type: string
                example: "convex-sync-v1"
        '400':
          description: Invalid sync request
          content:
            text/plain:
              schema:
                type: string

  /api/proxy/{service}/{path}:
    get:
      summary: Proxy GET request
      description: |
        Proxies authenticated requests to backend services.
        Requires valid authentication.
      tags:
        - Proxy
      security:
        - cookieAuth: []
        - bearerAuth: []
      parameters:
        - name: service
          in: path
          required: true
          schema:
            type: string
          description: Target service name
        - name: path
          in: path
          required: true
          schema:
            type: string
          description: Path within the service
      responses:
        '200':
          description: Proxied response from backend service
          content:
            application/json:
              schema:
                type: object
        '401':
          $ref: '#/components/responses/Unauthorized'
        '403':
          $ref: '#/components/responses/Forbidden'
        '502':
          $ref: '#/components/responses/BadGateway'

    post:
      summary: Proxy POST request
      description: Proxies authenticated POST requests to backend services
      tags:
        - Proxy
      security:
        - cookieAuth: []
        - bearerAuth: []
      parameters:
        - name: service
          in: path
          required: true
          schema:
            type: string
        - name: path
          in: path
          required: true
          schema:
            type: string
      requestBody:
        content:
          application/json:
            schema:
              type: object
      responses:
        '200':
          description: Proxied response
          content:
            application/json:
              schema:
                type: object
        '401':
          $ref: '#/components/responses/Unauthorized'
        '403':
          $ref: '#/components/responses/Forbidden'
        '502':
          $ref: '#/components/responses/BadGateway'

    put:
      summary: Proxy PUT request
      tags:
        - Proxy
      security:
        - cookieAuth: []
        - bearerAuth: []
      parameters:
        - name: service
          in: path
          required: true
          schema:
            type: string
        - name: path
          in: path
          required: true
          schema:
            type: string
      requestBody:
        content:
          application/json:
            schema:
              type: object
      responses:
        '200':
          description: Proxied response
        '401':
          $ref: '#/components/responses/Unauthorized'
        '403':
          $ref: '#/components/responses/Forbidden'

    delete:
      summary: Proxy DELETE request
      tags:
        - Proxy
      security:
        - cookieAuth: []
        - bearerAuth: []
      parameters:
        - name: service
          in: path
          required: true
          schema:
            type: string
        - name: path
          in: path
          required: true
          schema:
            type: string
      responses:
        '200':
          description: Proxied response
        '401':
          $ref: '#/components/responses/Unauthorized'
        '403':
          $ref: '#/components/responses/Forbidden'

components:
  securitySchemes:
    bearerAuth:
      type: http
      scheme: bearer
      bearerFormat: JWT
      description: JWT token in Authorization header
    cookieAuth:
      type: apiKey
      in: cookie
      name: auth-session
      description: Session cookie set by the auth service

  schemas:
    ApiInfo:
      type: object
      properties:
        name:
          type: string
          example: "Hono Authentication Gateway"
        version:
          type: string
          example: "1.0.0"
        environment:
          type: string
          enum: [development, staging, production]
        timestamp:
          type: string
          format: date-time
        endpoints:
          type: object
          properties:
            health:
              type: string
              example: "/health"
            auth:
              type: string
              example: "/auth"
            api:
              type: string
              example: "/api/*"
            websocket:
              type: string
              example: "/api/ws"
            convex_sync:
              type: string
              example: "/api/sync"
            convex_functions:
              type: string
              example: "/api/function/*"
            better_auth:
              type: string
              example: "/api/auth/*"
            proxy:
              type: string
              example: "/api/proxy/*"

    HealthCheck:
      type: object
      required:
        - status
        - timestamp
        - version
      properties:
        status:
          type: string
          enum: [healthy, unhealthy]
        timestamp:
          type: string
          format: date-time
        version:
          type: string
        uptime:
          type: number
          description: Uptime in seconds
        checks:
          type: object
          properties:
            convex:
              type: string
              enum: [healthy, unhealthy]
            session_store:
              type: string
              enum: [healthy, unhealthy]
            database:
              type: string
              enum: [healthy, unhealthy]
            websocket:
              type: string
              enum: [healthy, unhealthy]
            better_auth:
              type: string
              enum: [healthy, unhealthy]
        metrics:
          type: object
          properties:
            memory_usage:
              type: number
            cpu_usage:
              type: number
            active_sessions:
              type: number
            requests_per_minute:
              type: number
            websocket_connections:
              type: number
              description: Current WebSocket connections
            websocket_messages_per_minute:
              type: number
              description: WebSocket messages processed per minute

    SessionInfo:
      type: object
      properties:
        user:
          $ref: '#/components/schemas/User'
        session:
          type: object
          properties:
            id:
              type: string
            expiresAt:
              type: string
              format: date-time
        isAuthenticated:
          type: boolean

    User:
      type: object
      properties:
        id:
          type: string
        email:
          type: string
          format: email
        name:
          type: string
        image:
          type: string
          format: uri
        provider:
          type: string
          enum: [google, github, discord]
        createdAt:
          type: string
          format: date-time

    TokenResponse:
      type: object
      required:
        - accessToken
        - tokenType
        - expiresIn
      properties:
        accessToken:
          type: string
          description: JWT access token
        refreshToken:
          type: string
          description: Refresh token for obtaining new access tokens
        tokenType:
          type: string
          example: "Bearer"
        expiresIn:
          type: number
          description: Token expiration time in seconds
          example: 3600

    SuccessResponse:
      type: object
      properties:
        success:
          type: boolean
          example: true
        message:
          type: string

    ErrorResponse:
      type: object
      required:
        - success
        - error
      properties:
        success:
          type: boolean
          example: false
        error:
          type: object
          required:
            - message
            - code
          properties:
            message:
              type: string
              description: Human-readable error message
            code:
              type: string
              description: Error code for client handling
              enum:
                - INVALID_REQUEST
                - UNAUTHORIZED
                - FORBIDDEN
                - NOT_FOUND
                - RATE_LIMITED
                - INTERNAL_ERROR
                - BAD_GATEWAY
                - SERVICE_UNAVAILABLE
                - WEBSOCKET_ERROR
                - CONVEX_ERROR
                - BETTER_AUTH_ERROR
                - PROTOCOL_ERROR
            details:
              type: string
              description: Additional error details
            request_id:
              type: string
              description: Request ID for debugging

    WebSocketMessage:
      type: object
      required:
        - type
      properties:
        type:
          type: string
          description: Message type identifier
          example: "Connect"
        data:
          type: object
          description: Message payload data
        id:
          type: string
          description: Optional message identifier
        timestamp:
          type: number
          description: Message timestamp
          example: 1640995200000

    ConvexClientMessage:
      type: object
      discriminator:
        propertyName: type
      required:
        - type
      properties:
        type:
          type: string
          enum: [
            "Connect",
            "Authenticate", 
            "ModifyQuerySet",
            "Mutation",
            "Action",
            "Event"
          ]
      oneOf:
        - $ref: '#/components/schemas/ConvexConnectMessage'
        - $ref: '#/components/schemas/ConvexAuthenticateMessage'
        - $ref: '#/components/schemas/ConvexMutationRequest'
        - $ref: '#/components/schemas/ConvexActionRequest'

    ConvexConnectMessage:
      type: object
      required:
        - type
        - sessionId
        - connectionCount
      properties:
        type:
          type: string
          enum: ["Connect"]
        sessionId:
          type: string
          description: Client session identifier
        connectionCount:
          type: number
          description: Number of connections for this session
        lastCloseReason:
          type: string
          nullable: true
          description: Reason for last connection close
        maxObservedTimestamp:
          type: string
          description: Base64-encoded timestamp of last observed update
          example: "AAAAAAAAAAA="

    ConvexAuthenticateMessage:
      type: object
      required:
        - type
        - tokenType
        - baseVersion
      properties:
        type:
          type: string
          enum: ["Authenticate"]
        tokenType:
          type: string
          enum: ["Admin", "User", "None"]
        value:
          type: string
          nullable: true
          description: Authentication token value
        baseVersion:
          type: number
          description: Base version for authentication

    ConvexMutationRequest:
      type: object
      required:
        - type
        - requestId
        - udfPath
        - args
      properties:
        type:
          type: string
          enum: ["Mutation"]
        requestId:
          type: number
          description: Unique request identifier
        udfPath:
          type: string
          description: Path to the mutation function
          example: "messages/send"
        args:
          type: array
          description: Function arguments
          items:
            type: object
        componentPath:
          type: string
          nullable: true
          description: Optional component path

    ConvexActionRequest:
      type: object
      required:
        - type
        - requestId
        - udfPath
        - args
      properties:
        type:
          type: string
          enum: ["Action"]
        requestId:
          type: number
          description: Unique request identifier
        udfPath:
          type: string
          description: Path to the action function
          example: "emails/send"
        args:
          type: array
          description: Function arguments
          items:
            type: object
        componentPath:
          type: string
          nullable: true
          description: Optional component path

    ConvexServerMessage:
      type: object
      discriminator:
        propertyName: type
      required:
        - type
      properties:
        type:
          type: string
          enum: [
            "Transition",
            "MutationResponse",
            "ActionResponse", 
            "AuthError",
            "FatalError",
            "Ping"
          ]
      oneOf:
        - $ref: '#/components/schemas/ConvexTransitionMessage'
        - $ref: '#/components/schemas/ConvexMutationResponse'
        - $ref: '#/components/schemas/ConvexActionResponse'

    ConvexTransitionMessage:
      type: object
      required:
        - type
        - startVersion
        - endVersion
        - modifications
      properties:
        type:
          type: string
          enum: ["Transition"]
        startVersion:
          $ref: '#/components/schemas/ConvexStateVersion'
        endVersion:
          $ref: '#/components/schemas/ConvexStateVersion'
        modifications:
          type: array
          items:
            $ref: '#/components/schemas/ConvexStateModification'

    ConvexStateVersion:
      type: object
      required:
        - querySet
        - ts
        - identity
      properties:
        querySet:
          type: number
          description: Query set version
        ts:
          type: string
          description: Base64-encoded timestamp
          example: "AAAAAAAAAAA="
        identity:
          type: number
          description: Identity version

    ConvexStateModification:
      type: object
      required:
        - type
        - queryId
        - logLines
      properties:
        type:
          type: string
          enum: ["QueryUpdated", "QueryFailed", "QueryRemoved"]
        queryId:
          type: number
        value:
          type: object
          nullable: true
        errorMessage:
          type: string
          nullable: true
        logLines:
          type: array
          items:
            type: string
        journal:
          type: string
          nullable: true
        errorData:
          type: object
          nullable: true

    ConvexMutationResponse:
      type: object
      required:
        - type
        - requestId
        - success
        - result
        - logLines
      properties:
        type:
          type: string
          enum: ["MutationResponse"]
        requestId:
          type: number
        success:
          type: boolean
        result:
          type: object
        ts:
          type: string
          nullable: true
          description: Base64-encoded timestamp if successful
        logLines:
          type: array
          items:
            type: string
        errorData:
          type: object
          nullable: true

    ConvexActionResponse:
      type: object
      required:
        - type
        - requestId
        - success
        - result
        - logLines
      properties:
        type:
          type: string
          enum: ["ActionResponse"]
        requestId:
          type: number
        success:
          type: boolean
        result:
          type: object
        logLines:
          type: array
          items:
            type: string
        errorData:
          type: object
          nullable: true

    ConvexFunctionRequest:
      type: object
      required:
        - args
      properties:
        args:
          type: array
          description: Function arguments
          items:
            type: object
        format:
          type: string
          enum: ["json", "convex_encoded_json"]
          default: "json"
          description: Argument encoding format

    ConvexFunctionResponse:
      type: object
      required:
        - success
        - result
      properties:
        success:
          type: boolean
        result:
          type: object
          description: Function execution result
        logLines:
          type: array
          items:
            type: string
          description: Function execution logs
        errorData:
          type: object
          nullable: true
          description: Error details if success is false

    BetterAuthSession:
      type: object
      properties:
        user:
          type: object
          properties:
            id:
              type: string
            email:
              type: string
              format: email
            name:
              type: string
            image:
              type: string
              format: uri
            emailVerified:
              type: boolean
        session:
          type: object
          properties:
            id:
              type: string
            expiresAt:
              type: string
              format: date-time
            token:
              type: string
        isAuthenticated:
          type: boolean

    WebSocketConnectionInfo:
      type: object
      properties:
        connected:
          type: boolean
        connectedAt:
          type: string
          format: date-time
        protocol:
          type: string
          example: "convex-sync-v1"
        userId:
          type: string
        connectionId:
          type: string

  responses:
    BadRequest:
      description: Invalid request
      content:
        application/json:
          schema:
            $ref: '#/components/schemas/ErrorResponse'
          example:
            success: false
            error:
              message: "Invalid request parameters"
              code: "INVALID_REQUEST"
              details: "Missing required field: callbackURL"

    Unauthorized:
      description: Authentication required
      content:
        application/json:
          schema:
            $ref: '#/components/schemas/ErrorResponse'
          example:
            success: false
            error:
              message: "Authentication required"
              code: "UNAUTHORIZED"

    Forbidden:
      description: Access forbidden
      content:
        application/json:
          schema:
            $ref: '#/components/schemas/ErrorResponse'
          example:
            success: false
            error:
              message: "Access forbidden"
              code: "FORBIDDEN"

    RateLimited:
      description: Rate limit exceeded
      headers:
        X-RateLimit-Limit:
          schema:
            type: integer
          description: Request limit per window
        X-RateLimit-Remaining:
          schema:
            type: integer
          description: Remaining requests in window
        X-RateLimit-Reset:
          schema:
            type: integer
          description: Time when rate limit resets (Unix timestamp)
      content:
        application/json:
          schema:
            $ref: '#/components/schemas/ErrorResponse'
          example:
            success: false
            error:
              message: "Rate limit exceeded"
              code: "RATE_LIMITED"
              details: "Try again in 60 seconds"

    BadGateway:
      description: Backend service error
      content:
        application/json:
          schema:
            $ref: '#/components/schemas/ErrorResponse'
          example:
            success: false
            error:
              message: "Backend service error"
              code: "BAD_GATEWAY"
              details: "Unable to reach backend service"

security:
  - bearerAuth: []
  - cookieAuth: []
`;

/**
 * Serve OpenAPI specification
 */
openApiRoutes.get('/openapi.yaml', (c) => {
  console.log('[OpenAPI] Serving YAML spec from:', c.req.path);
  return c.text(openApiSpec, 200, {
    'Content-Type': 'application/x-yaml',
    'Cache-Control': 'public, max-age=3600',
  });
});

openApiRoutes.get('/openapi.json', async (c) => {
  // Convert YAML to JSON
  // For now, we'll return a simple message since we don't have a YAML parser
  return c.json({
    info: {
      title: 'Authentication Gateway API',
      version: '1.0.0',
      description: 'Please use /docs/openapi.yaml for the full specification',
    },
    notice: 'Full OpenAPI specification available at /docs/openapi.yaml',
  });
});

/**
 * Swagger UI HTML
 */
const swaggerUiHtml = `
<!DOCTYPE html>
<html lang="en">
<head>
  <title>Auth API Documentation</title>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5.11.0/swagger-ui.css" />
  <style>
    body {
      margin: 0;
      padding: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    .swagger-ui .topbar {
      display: none;
    }
    #swagger-ui {
      max-width: 1460px;
      margin: 0 auto;
      padding: 20px;
    }
    .api-info {
      background: #f7f8fa;
      border: 1px solid #e1e4e8;
      border-radius: 6px;
      padding: 20px;
      margin-bottom: 30px;
    }
    .api-info h1 {
      margin: 0 0 10px 0;
      color: #24292e;
    }
    .api-info p {
      margin: 0;
      color: #586069;
    }
    .security-notice {
      background: #fff5b1;
      border: 1px solid #f9c513;
      border-radius: 6px;
      padding: 15px;
      margin-bottom: 20px;
    }
    .security-notice h3 {
      margin: 0 0 10px 0;
      color: #735c0f;
    }
    .security-notice ul {
      margin: 5px 0;
      padding-left: 20px;
    }
  </style>
</head>
<body>
  <div id="swagger-ui">
    <div class="api-info">
      <h1>Authentication Gateway API</h1>
      <p>Central authentication gateway service using Cloudflare Workers, KV storage, and Convex</p>
    </div>
    <div class="security-notice">
      <h3>⚠️ Security Notice</h3>
      <p>This API handles sensitive authentication data. When developing clients:</p>
      <ul>
        <li>Always use HTTPS in production</li>
        <li>Never store tokens in localStorage (use httpOnly cookies)</li>
        <li>Implement CSRF protection</li>
        <li>Follow OAuth 2.0 best practices</li>
        <li>Validate all inputs</li>
      </ul>
    </div>
  </div>
  <script src="https://unpkg.com/swagger-ui-dist@5.11.0/swagger-ui-bundle.js"></script>
  <script src="https://unpkg.com/swagger-ui-dist@5.11.0/swagger-ui-standalone-preset.js"></script>
  <script>
    window.onload = function() {
      window.ui = SwaggerUIBundle({
        url: "./openapi.yaml",
        dom_id: '#swagger-ui',
        deepLinking: true,
        presets: [
          SwaggerUIBundle.presets.apis,
          SwaggerUIStandalonePreset
        ],
        plugins: [
          SwaggerUIBundle.plugins.DownloadUrl
        ],
        layout: "StandaloneLayout",
        defaultModelsExpandDepth: 1,
        defaultModelExpandDepth: 1,
        docExpansion: "list",
        filter: true,
        showExtensions: true,
        showCommonExtensions: true,
        tryItOutEnabled: true,
        supportedSubmitMethods: ['get', 'post', 'put', 'delete', 'patch'],
        onComplete: function() {
          console.log("Swagger UI loaded");
        }
      });
    }
  </script>
</body>
</html>
`;

/**
 * Serve Swagger UI
 */
openApiRoutes.get('/', (c) => {
  console.log('[OpenAPI] Serving Swagger UI from:', c.req.path);
  return c.html(swaggerUiHtml, 200, {
    'Content-Type': 'text/html; charset=utf-8',
  });
});

/**
 * Redirect /api/docs to /docs (for backwards compatibility)
 */
openApiRoutes.get('/api/docs', (c) => {
  return c.redirect('/docs/', 301);
});

export { openApiRoutes };