import { NextRequest, NextResponse } from "next/server";

export interface DockerHubSearchResult {
  name: string;
  description: string;
  star_count: number;
  pull_count: number;
  is_official: boolean;
}

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const query = searchParams.get("query")?.trim() || "";

  if (!query) {
    return NextResponse.json({ results: [] });
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 6000);

    const dockerHubUrl = `https://hub.docker.com/v2/search/repositories/?query=${encodeURIComponent(
      query
    )}&page_size=20`;

    const res = await fetch(dockerHubUrl, {
      signal: controller.signal,
      headers: {
        Accept: "application/json",
      },
    });

    clearTimeout(timeoutId);

    if (!res.ok) {
      return NextResponse.json({
        results: [],
        warning: `Docker Hub returned status ${res.status}`,
      });
    }

    const data = await res.json();
    const rawResults = Array.isArray(data?.results) ? data.results : [];

    const results: DockerHubSearchResult[] = rawResults
      .map((item: any) => ({
        name: item.repo_name || item.name || "",
        description: item.short_description || item.description || "",
        star_count: item.star_count ?? 0,
        pull_count: item.pull_count ?? 0,
        is_official: Boolean(item.is_official),
      }))
      .filter((item: DockerHubSearchResult) => item.name.length > 0);

    return NextResponse.json({ results });
  } catch (error: any) {
    return NextResponse.json({
      results: [],
      error: error?.message || "Failed to query Docker Hub",
    });
  }
}
