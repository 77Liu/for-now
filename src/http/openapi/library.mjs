const response = schema => ({
  content: {
    "application/json": {
      schema: {
        allOf: [
          { $ref: "#/components/schemas/SuccessEnvelope" },
          { properties: { data: schema } }
        ]
      }
    }
  }
});

const errors = {
  "400": { $ref: "#/components/responses/BadRequest" },
  "401": { $ref: "#/components/responses/Unauthorized" },
  "404": { $ref: "#/components/responses/NotFound" },
  "409": { $ref: "#/components/responses/Conflict" }
};

const listParameters = [
  { $ref: "#/components/parameters/Cursor" },
  { $ref: "#/components/parameters/Limit" }
];

const etagHeader = {
  ETag: {
    description: "资源的整数版本，更新或删除时原样传入 If-Match",
    schema: { type: "string" }
  }
};

const conditionalErrors = {
  "412": { $ref: "#/components/responses/PreconditionFailed" },
  "428": { $ref: "#/components/responses/PreconditionRequired" }
};

export const libraryPaths = Object.freeze({
  "/books": {
    get: {
      operationId: "listBooks",
      parameters: listParameters,
      responses: {
        "200": {
          description: "书目列表",
          ...response({ type: "array", items: { $ref: "#/components/schemas/Book" } })
        },
        ...errors
      }
    },
    post: {
      operationId: "createBook",
      parameters: [{ $ref: "#/components/parameters/IdempotencyKey" }],
      requestBody: {
        required: true,
        content: { "application/json": { schema: { $ref: "#/components/schemas/BookCreateInput" } } }
      },
      responses: {
        "200": {
          description: "幂等请求复用既有书目",
          headers: etagHeader,
          ...response({ $ref: "#/components/schemas/Book" })
        },
        "201": {
          description: "已创建书目",
          headers: etagHeader,
          ...response({ $ref: "#/components/schemas/Book" })
        },
        ...errors
      }
    }
  },
  "/books/parse": {
    post: {
      operationId: "parseBookImage",
      requestBody: {
        required: true,
        content: { "application/json": { schema: { $ref: "#/components/schemas/BookParseInput" } } }
      },
      responses: {
        "200": {
          description: "已识别书籍信息；结果需由用户核对后另行创建书目",
          ...response({ $ref: "#/components/schemas/BookParseResult" })
        },
        "400": errors["400"],
        "401": errors["401"]
      }
    }
  },
  "/books/{bookId}": {
    parameters: [{ $ref: "#/components/parameters/BookId" }],
    get: {
      operationId: "getBook",
      responses: {
        "200": {
          description: "书目详情",
          headers: etagHeader,
          ...response({ $ref: "#/components/schemas/Book" })
        },
        ...errors
      }
    },
    patch: {
      operationId: "updateBook",
      parameters: [{ $ref: "#/components/parameters/IfMatch" }],
      requestBody: {
        required: true,
        content: { "application/json": { schema: { $ref: "#/components/schemas/BookUpdateInput" } } }
      },
      responses: {
        "200": {
          description: "已更新书目",
          headers: etagHeader,
          ...response({ $ref: "#/components/schemas/Book" })
        },
        ...conditionalErrors,
        ...errors
      }
    },
    delete: {
      operationId: "deleteBook",
      parameters: [{ $ref: "#/components/parameters/IfMatch" }],
      responses: {
        "200": {
          description: "已移入回收站",
          ...response({ $ref: "#/components/schemas/TrashReference" })
        },
        ...conditionalErrors,
        ...errors
      }
    }
  },
  "/books/{bookId}/notes": {
    parameters: [{ $ref: "#/components/parameters/BookId" }],
    get: {
      operationId: "listBookNotes",
      parameters: listParameters,
      responses: {
        "200": {
          description: "读书笔记列表",
          ...response({ type: "array", items: { $ref: "#/components/schemas/BookNote" } })
        },
        ...errors
      }
    },
    post: {
      operationId: "createBookNote",
      parameters: [{ $ref: "#/components/parameters/IdempotencyKey" }],
      requestBody: {
        required: true,
        content: { "application/json": { schema: { $ref: "#/components/schemas/BookNoteCreateInput" } } }
      },
      responses: {
        "200": {
          description: "幂等请求复用既有读书笔记",
          headers: etagHeader,
          ...response({ $ref: "#/components/schemas/BookNote" })
        },
        "201": {
          description: "已创建读书笔记",
          headers: etagHeader,
          ...response({ $ref: "#/components/schemas/BookNote" })
        },
        ...errors
      }
    }
  },
  "/books/{bookId}/notes/{noteId}": {
    parameters: [
      { $ref: "#/components/parameters/BookId" },
      { $ref: "#/components/parameters/BookNoteId" }
    ],
    get: {
      operationId: "getBookNote",
      responses: {
        "200": {
          description: "读书笔记详情",
          headers: etagHeader,
          ...response({ $ref: "#/components/schemas/BookNote" })
        },
        ...errors
      }
    },
    patch: {
      operationId: "updateBookNote",
      parameters: [{ $ref: "#/components/parameters/IfMatch" }],
      requestBody: {
        required: true,
        content: { "application/json": { schema: { $ref: "#/components/schemas/BookNoteUpdateInput" } } }
      },
      responses: {
        "200": {
          description: "已更新读书笔记",
          headers: etagHeader,
          ...response({ $ref: "#/components/schemas/BookNote" })
        },
        ...conditionalErrors,
        ...errors
      }
    },
    delete: {
      operationId: "deleteBookNote",
      parameters: [{ $ref: "#/components/parameters/IfMatch" }],
      responses: {
        "200": {
          description: "已移入回收站",
          ...response({ $ref: "#/components/schemas/TrashReference" })
        },
        ...conditionalErrors,
        ...errors
      }
    }
  },
  "/quotes": {
    get: {
      operationId: "listQuotes",
      parameters: listParameters,
      responses: {
        "200": {
          description: "拾句列表",
          ...response({ type: "array", items: { $ref: "#/components/schemas/Quote" } })
        },
        ...errors
      }
    },
    post: {
      operationId: "createQuote",
      parameters: [{ $ref: "#/components/parameters/IdempotencyKey" }],
      requestBody: {
        required: true,
        content: { "application/json": { schema: { $ref: "#/components/schemas/QuoteCreateInput" } } }
      },
      responses: {
        "200": {
          description: "幂等请求复用既有拾句",
          headers: etagHeader,
          ...response({ $ref: "#/components/schemas/Quote" })
        },
        "201": {
          description: "已创建拾句",
          headers: etagHeader,
          ...response({ $ref: "#/components/schemas/Quote" })
        },
        ...errors
      }
    }
  },
  "/quotes/{quoteId}": {
    parameters: [{ $ref: "#/components/parameters/QuoteId" }],
    get: {
      operationId: "getQuote",
      responses: {
        "200": {
          description: "拾句详情",
          headers: etagHeader,
          ...response({ $ref: "#/components/schemas/Quote" })
        },
        ...errors
      }
    },
    patch: {
      operationId: "updateQuote",
      parameters: [{ $ref: "#/components/parameters/IfMatch" }],
      requestBody: {
        required: true,
        content: { "application/json": { schema: { $ref: "#/components/schemas/QuoteUpdateInput" } } }
      },
      responses: {
        "200": {
          description: "已更新拾句",
          headers: etagHeader,
          ...response({ $ref: "#/components/schemas/Quote" })
        },
        ...conditionalErrors,
        ...errors
      }
    },
    delete: {
      operationId: "deleteQuote",
      parameters: [{ $ref: "#/components/parameters/IfMatch" }],
      responses: {
        "200": {
          description: "已移入回收站",
          ...response({ $ref: "#/components/schemas/TrashReference" })
        },
        ...conditionalErrors,
        ...errors
      }
    }
  }
});

const eventTimeProperties = {
  occurredAt: { type: "string" },
  occurredOn: { type: "string", format: "date" },
  timeMode: { enum: ["now", "manual"] }
};

const bookProperties = {
  title: { type: "string", maxLength: 300 },
  author: { type: "string", maxLength: 200 },
  publisher: { type: "string", maxLength: 200 },
  isbn: { type: "string", maxLength: 80 },
  description: { type: "string", maxLength: 2000 },
  readingStartedOn: { type: "string", format: "date" },
  readingFinishedOn: { type: "string" },
  imagePath: { type: "string" }
};

const noteProperties = {
  ...eventTimeProperties,
  type: { enum: ["record", "thought"] },
  favorite: { enum: ["none", "star", "sprout"] },
  content: { type: "string", maxLength: 12000 }
};

const quoteProperties = {
  ...eventTimeProperties,
  source: { type: "string", maxLength: 500 },
  content: { type: "string", maxLength: 5000 },
  tags: {
    type: "array",
    maxItems: 8,
    items: { type: "string", maxLength: 30 }
  }
};

export const libraryComponents = Object.freeze({
  parameters: Object.freeze({
    BookId: { name: "bookId", in: "path", required: true, schema: { type: "string", maxLength: 100 } },
    BookNoteId: { name: "noteId", in: "path", required: true, schema: { type: "string", maxLength: 100 } },
    QuoteId: { name: "quoteId", in: "path", required: true, schema: { type: "string", maxLength: 100 } }
  }),
  schemas: Object.freeze({
    BookCreateInput: {
      type: "object",
      required: ["title", "readingStartedOn"],
      properties: bookProperties,
      additionalProperties: false
    },
    BookUpdateInput: {
      type: "object",
      properties: bookProperties,
      additionalProperties: false
    },
    Book: {
      type: "object",
      required: ["id", "createdAt", "title", "notes", "version"],
      properties: {
        id: { type: "string" },
        createdAt: { type: "string", format: "date-time" },
        updatedAt: { type: "string", format: "date-time" },
        version: { type: "integer", minimum: 1 },
        ...bookProperties,
        notes: { type: "array", items: { $ref: "#/components/schemas/BookNote" } },
        annotations: { type: "array", items: { type: "object", additionalProperties: true } },
        annotationDrift: { type: "array", items: { type: "object", additionalProperties: true } }
      },
      additionalProperties: true
    },
    BookNoteCreateInput: {
      type: "object",
      required: ["content"],
      properties: noteProperties,
      additionalProperties: false
    },
    BookNoteUpdateInput: {
      type: "object",
      properties: noteProperties,
      minProperties: 1,
      additionalProperties: false
    },
    BookNote: {
      type: "object",
      required: ["id", "createdAt", "occurredAt", "occurredOn", "type", "favorite", "content", "version"],
      properties: {
        id: { type: "string" },
        createdAt: { type: "string", format: "date-time" },
        updatedAt: { type: "string", format: "date-time" },
        version: { type: "integer", minimum: 1 },
        ...noteProperties
      },
      additionalProperties: true
    },
    BookParseInput: {
      type: "object",
      properties: {
        image: { type: "string" },
        images: { type: "array", minItems: 1, maxItems: 1, items: { type: "string" } }
      },
      oneOf: [
        { required: ["image"] },
        { required: ["images"] }
      ],
      additionalProperties: false
    },
    BookParseResult: {
      type: "object",
      required: ["title", "author", "publisher", "isbn", "description", "verification", "attachmentPaths"],
      properties: {
        title: { type: "string" },
        author: { type: "string" },
        publisher: { type: "string" },
        isbn: { type: "string" },
        description: { type: "string" },
        verification: { type: "string" },
        attachmentPaths: { type: "array", maxItems: 1, items: { type: "string" } }
      },
      additionalProperties: false
    },
    QuoteCreateInput: {
      type: "object",
      required: ["source", "content"],
      properties: quoteProperties,
      additionalProperties: false
    },
    QuoteUpdateInput: {
      type: "object",
      properties: quoteProperties,
      minProperties: 1,
      additionalProperties: false
    },
    Quote: {
      type: "object",
      required: ["id", "createdAt", "occurredAt", "occurredOn", "source", "content", "tags", "version"],
      properties: {
        id: { type: "string" },
        createdAt: { type: "string", format: "date-time" },
        updatedAt: { type: "string", format: "date-time" },
        version: { type: "integer", minimum: 1 },
        ...quoteProperties,
        annotations: { type: "array", items: { type: "object", additionalProperties: true } },
        annotationDrift: { type: "array", items: { type: "object", additionalProperties: true } }
      },
      additionalProperties: true
    }
  })
});

export const libraryOpenApiFragment = Object.freeze({
  paths: libraryPaths,
  components: libraryComponents
});
