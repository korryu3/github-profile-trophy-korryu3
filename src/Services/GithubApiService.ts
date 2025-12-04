import { GithubRepository } from "../Repository/GithubRepository.ts";
import {
  GitHubUserActivity,
  GitHubUserContributionsByYear,
  GitHubUserIssue,
  GitHubUserPullRequest,
  GitHubUserRepository,
  UserInfo,
} from "../user_info.ts";
import {
  queryUserActivity,
  queryUserContributionsByYear,
  queryUserIssue,
  queryUserPullRequest,
  queryUserRepository,
} from "../Schemas/index.ts";
import { Retry } from "../Helpers/Retry.ts";
import { CONSTANTS } from "../utils.ts";
import { EServiceKindError, ServiceError } from "../Types/index.ts";
import { Logger } from "../Helpers/Logger.ts";
import { requestGithubData } from "./request.ts";

// Need to be here - Exporting from another file makes array of null
export const TOKENS = [
  Deno.env.get("GITHUB_TOKEN1"),
  Deno.env.get("GITHUB_TOKEN2"),
];

export class GithubApiService extends GithubRepository {
  async requestUserRepository(
    username: string,
  ): Promise<GitHubUserRepository | ServiceError> {
    return await this.executeQuery<GitHubUserRepository>(queryUserRepository, {
      username,
    });
  }
  async requestUserActivity(
    username: string,
  ): Promise<GitHubUserActivity | ServiceError> {
    return await this.executeQuery<GitHubUserActivity>(queryUserActivity, {
      username,
    });
  }

  async requestUserContributionsByYear(
    username: string,
    from: string,
    to: string,
  ): Promise<GitHubUserContributionsByYear | ServiceError> {
    return await this.executeQuery<GitHubUserContributionsByYear>(
      queryUserContributionsByYear,
      {
        username,
        from,
        to,
      },
    );
  }

  async requestAllTimeCommits(username: string, createdAt: string): Promise<number> {
    const accountCreationDate = new Date(createdAt);
    const now = new Date();
    let totalCommits = 0;

    // Calculate years from account creation to now
    const startYear = accountCreationDate.getFullYear();
    const currentYear = now.getFullYear();

    // Fetch contributions year by year
    for (let year = startYear; year <= currentYear; year++) {
      const fromDate = year === startYear
        ? accountCreationDate.toISOString()
        : new Date(year, 0, 1).toISOString();
      
      const toDate = year === currentYear
        ? now.toISOString()
        : new Date(year, 11, 31, 23, 59, 59).toISOString();

      try {
        const result = await this.requestUserContributionsByYear(
          username,
          fromDate,
          toDate,
        );

        if (result instanceof ServiceError) {
          Logger.error(`Failed to fetch contributions for year ${year}`);
          continue;
        }

        const yearCommits = result.contributionsCollection.totalCommitContributions +
          result.contributionsCollection.restrictedContributionsCount;
        
        totalCommits += yearCommits;
      } catch (error) {
        Logger.error(`Error fetching year ${year}: ${error}`);
      }
    }

    return totalCommits;
  }
  async requestUserIssue(
    username: string,
  ): Promise<GitHubUserIssue | ServiceError> {
    return await this.executeQuery<GitHubUserIssue>(queryUserIssue, {
      username,
    });
  }
  async requestUserPullRequest(
    username: string,
  ): Promise<GitHubUserPullRequest | ServiceError> {
    return await this.executeQuery<GitHubUserPullRequest>(
      queryUserPullRequest,
      { username },
    );
  }
  async requestUserInfo(username: string): Promise<UserInfo | ServiceError> {
    // Avoid to call others if one of them is null

    const promises = Promise.allSettled([
      this.requestUserRepository(username),
      this.requestUserActivity(username),
      this.requestUserIssue(username),
      this.requestUserPullRequest(username),
    ]);
    try {
      const [repository, activity, issue, pullRequest] = await promises;
      const status = [
        repository.status,
        activity.status,
        issue.status,
        pullRequest.status,
      ];

      if (status.includes("rejected")) {
        Logger.error(`Can not find a user with username:' ${username}'`);
        return new ServiceError("Not found", EServiceKindError.NOT_FOUND);
      }

      const activityValue = (activity as PromiseFulfilledResult<GitHubUserActivity>).value;

      // Fetch all-time commits
      const allTimeCommits = await this.requestAllTimeCommits(
        username,
        activityValue.createdAt,
      );

      return new UserInfo(
        activityValue,
        (issue as PromiseFulfilledResult<GitHubUserIssue>).value,
        (pullRequest as PromiseFulfilledResult<GitHubUserPullRequest>).value,
        (repository as PromiseFulfilledResult<GitHubUserRepository>).value,
        allTimeCommits,
      );
    } catch {
      Logger.error(`Error fetching user info for username: ${username}`);
      return new ServiceError("Not found", EServiceKindError.NOT_FOUND);
    }
  }

  async executeQuery<T = unknown>(
    query: string,
    variables: { [key: string]: string },
  ) {
    try {
      const retry = new Retry(
        TOKENS.length,
        CONSTANTS.DEFAULT_GITHUB_RETRY_DELAY,
      );
      return await retry.fetch<Promise<T>>(async ({ attempt }) => {
        return await requestGithubData(
          query,
          variables,
          TOKENS[attempt],
        );
      });
    } catch (error) {
      if (error.cause instanceof ServiceError) {
        Logger.error(error.cause.message);
        return error.cause;
      }
      if (error instanceof Error && error.cause) {
        Logger.error(JSON.stringify(error.cause, null, 2));
      } else {
        Logger.error(error);
      }
      return new ServiceError("not found", EServiceKindError.NOT_FOUND);
    }
  }
}
