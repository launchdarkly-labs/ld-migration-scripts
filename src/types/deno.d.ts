// <reference types="https://deno.land/x/deno@v1.37.1/mod.d.ts" />

declare namespace Deno {
  export interface Args {
    [key: string]: string;
  }

  export function readTextFile(path: string): Promise<string>;
  export function writeTextFile(path: string, data: string): Promise<void>;
  export function readDir(path: string): AsyncIterable<DirEntry>;
  export function exit(code: number): never;

  export interface DirEntry {
    name: string;
    isFile: boolean;
    isDirectory: boolean;
    isSymlink: boolean;
  }
}

// Flag Import Types
export interface ImportFlag {
  key: string;
  name?: string;
  description?: string;
  kind: "boolean" | "string" | "number" | "json";
  variations: (boolean | string | number | any)[];
  defaultOnVariation: boolean | string | number | any;
  defaultOffVariation: boolean | string | number | any;
  tags?: string[];
}

export interface LaunchDarklyFlag {
  key: string;
  name?: string;
  description?: string;
  kind: "boolean" | "string" | "number" | "json";
  variations: Array<{ value: any }>;
  defaults: {
    onVariation: number;
    offVariation: number;
  };
  tags?: string[];
}

export interface ImportResult {
  key: string;
  success: boolean;
  error?: string;
  timing?: number;
}

export interface ImportReport {
  totalFlags: number;
  successful: number;
  failed: number;
  results: ImportResult[];
  summary: string;
  timestamp: string;
} 