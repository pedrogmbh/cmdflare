/** Shared types for the generated command manifest. */

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type ParamLocation = 'path' | 'query' | 'body' | 'header';

export interface TypeSpec {
  kind: 'string' | 'number' | 'boolean' | 'enum' | 'array' | 'object' | 'record' | 'union' | 'file' | 'json';
  /** Human readable type text (for help). */
  text?: string;
  /** Enum values (kind === 'enum'). */
  enum?: Array<string | number>;
  /** Array item type (kind === 'array'). */
  items?: TypeSpec;
  /** Object properties (kind === 'object'), depth-limited. */
  props?: ParamProp[];
  /** Number of union variants merged into this object (kind === 'object'). */
  variants?: number;
  /** Union members (kind === 'union'). */
  members?: TypeSpec[];
  nullable?: boolean;
}

export interface ParamProp {
  name: string;
  required: boolean;
  type: TypeSpec;
  location?: ParamLocation;
  description?: string;
  deprecated?: boolean;
}

export interface Positional {
  name: string;
  cli: string;
  type: 'string' | 'number' | 'enum';
  enum?: string[];
  required: boolean;
  description?: string;
}

export interface MethodNode {
  name: string;
  cli: string;
  summary?: string;
  description?: string;
  http?: HttpMethod;
  path?: string;
  positionals: Positional[];
  params?: { name: string; required: boolean; type: TypeSpec };
  /** Pagination class name when the method returns a PagePromise. */
  paginated?: string;
  returns?: string;
  deprecated?: boolean;
  deprecatedNote?: string;
  destructive?: boolean;
  multipart?: boolean;
  binary?: boolean;
  /** Index-only: the method takes a params object (details live in the resource file). */
  hasParams?: boolean;
  paramsRequired?: boolean;
}

export interface ResourceNode {
  name: string;
  cli: string;
  className: string;
  module: string;
  description?: string;
  children: ResourceNode[];
  methods: MethodNode[];
}

export interface Manifest {
  sdkVersion: string;
  generatedAt: string;
  root: ResourceNode;
}
