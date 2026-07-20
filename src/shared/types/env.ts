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
