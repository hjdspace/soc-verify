export interface EdaToolInfo {
  name: string;
  version?: string;
  path: string;
  detected: boolean;
}

export interface EnvConfig {
  tools: EdaToolInfo[];
  envVars: Record<string, string>;
}

/** Environment variable category for grouped display. */
export type EnvVarCategory = 'soc' | 'synopsys' | 'cadence' | 'license' | 'system';

/** Definition of a single known environment variable. */
export type EnvVarDefinition = {
  name: string;
  category: EnvVarCategory;
  description: string;
  /** Whether this variable typically holds a directory path. */
  isPath?: boolean;
};

/** A group of environment variables sharing the same category. */
export type EnvVarGroup = {
  category: EnvVarCategory;
  label: string;
  description: string;
  vars: EnvVarDefinition[];
};

/** System-detected environment variable values (from current terminal/shell). */
export type SystemEnvVars = Record<string, string>;
