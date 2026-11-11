import { trimBase } from './http.js';

export interface GitLabConfig {
  // The site, such as https://gitlab.example.com; the API is under /api/v4.
  readonly baseUrl: string;
  readonly token: string;
  // The project path from the git remote (`group/sub/app`), or empty when the project has none.
  readonly projectPath: string;
}

export const gitLabApi = (baseUrl: string): string => `${trimBase(baseUrl)}/api/v4`;

// GitLab takes a project's whole path, nested groups and all, as one URL-encoded id.
export const gitLabProjectId = (projectPath: string): string => encodeURIComponent(projectPath);

// A personal or project access token goes in PRIVATE-TOKEN and nowhere else.
export const gitLabHeaders = (token: string): Record<string, string> => ({
  'private-token': token,
});
