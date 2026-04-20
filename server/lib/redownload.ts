import RadarrAPI, { type RadarrMovie } from '@server/api/servarr/radarr';
import SonarrAPI, { type SonarrSeries } from '@server/api/servarr/sonarr';
import { MediaStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';

export type RedownloadPayload = {
  is4k?: boolean;
  seasons?: number[];
  episodes?: { seasonNumber: number; episodeNumber: number }[];
};

interface EpisodeInfo {
  id: number;
  seasonNumber: number;
  episodeNumber: number;
  episodeFileId: number;
  monitored: boolean;
}

export class RedownloadError extends Error {
  public status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

class RedownloadService {
  public async redownload(
    mediaId: number,
    payload: RedownloadPayload
  ): Promise<{ success: boolean; message: string }> {
    const mediaRepository = getRepository(Media);
    const media = await mediaRepository.findOne({
      where: { id: mediaId },
      relations: { requests: true },
    });

    if (!media) {
      throw new RedownloadError(404, 'Media does not exist.');
    }

    const is4k = Boolean(payload.is4k);
    let serviceId = media[is4k ? 'serviceId4k' : 'serviceId'];
    let externalServiceId =
      media[is4k ? 'externalServiceId4k' : 'externalServiceId'];

    const settings = getSettings();

    if (serviceId == null || externalServiceId == null) {
      const discovered = await this.discoverMediaInService(
        media,
        settings,
        is4k
      );

      if (!discovered) {
        throw new RedownloadError(
          400,
          `Media is not configured in ${
            media.mediaType === MediaType.MOVIE ? 'Radarr' : 'Sonarr'
          }.`
        );
      }

      serviceId = discovered.serviceId;
      externalServiceId = discovered.externalServiceId;

      media[is4k ? 'serviceId4k' : 'serviceId'] = serviceId;
      media[is4k ? 'externalServiceId4k' : 'externalServiceId'] =
        externalServiceId;
      await mediaRepository.save(media);

      logger.info(
        'Discovered media in service and updated local database before re-download',
        {
          label: 'Media',
          mediaId,
          serviceId,
          externalServiceId,
        }
      );
    }

    if (media.mediaType === MediaType.MOVIE) {
      return this.redownloadMovie(
        media,
        settings,
        serviceId,
        externalServiceId,
        is4k
      );
    }

    return this.redownloadSeries(
      settings,
      serviceId,
      externalServiceId,
      payload
    );
  }

  private async redownloadMovie(
    media: Media,
    settings: ReturnType<typeof getSettings>,
    serviceId: number,
    movieId: number,
    is4k: boolean
  ): Promise<{ success: boolean; message: string }> {
    const radarrSettings = settings.radarr.find((r) => r.id === serviceId);

    if (!radarrSettings) {
      throw new RedownloadError(500, 'Radarr server configuration not found.');
    }

    const radarr = new RadarrAPI({
      apiKey: radarrSettings.apiKey,
      url: RadarrAPI.buildUrl(radarrSettings, '/api/v3'),
    });

    try {
      const movie = await radarr.getMovie({ id: movieId });

      await this.ensureMovieMonitored(radarr, movie);

      if (movie.hasFile && movie.movieFile?.id) {
        logger.info('Deleting existing movie file before re-download', {
          label: 'Media',
          movieId,
          movieFileId: movie.movieFile.id,
        });
        await radarr.deleteMovieFile(movie.movieFile.id);
      }
    } catch (e) {
      logger.warn(
        'Could not prepare movie for re-download, continuing with search',
        { label: 'Media', errorMessage: e.message }
      );
    }

    await radarr.searchMovie(movieId);

    const mediaRepository = getRepository(Media);
    media[is4k ? 'status4k' : 'status'] = MediaStatus.PROCESSING;
    await mediaRepository.save(media);

    return { success: true, message: 'Movie re-download initiated.' };
  }

  private async redownloadSeries(
    settings: ReturnType<typeof getSettings>,
    serviceId: number,
    seriesId: number,
    payload: RedownloadPayload
  ): Promise<{ success: boolean; message: string }> {
    const sonarrSettings = settings.sonarr.find((s) => s.id === serviceId);

    if (!sonarrSettings) {
      throw new RedownloadError(500, 'Sonarr server configuration not found.');
    }

    const sonarr = new SonarrAPI({
      apiKey: sonarrSettings.apiKey,
      url: SonarrAPI.buildUrl(sonarrSettings, '/api/v3'),
    });

    await this.ensureSeriesMonitored(sonarr, seriesId, payload);
    await this.deleteExistingEpisodeFiles(sonarr, seriesId, payload);

    return this.searchSonarr(sonarr, seriesId, payload);
  }

  private async discoverMediaInService(
    media: Media,
    settings: ReturnType<typeof getSettings>,
    is4k: boolean
  ): Promise<{ serviceId: number; externalServiceId: number } | null> {
    if (media.mediaType === MediaType.MOVIE) {
      return this.discoverMovieInRadarr(media, settings, is4k);
    }
    return this.discoverSeriesInSonarr(media, settings, is4k);
  }

  private async discoverMovieInRadarr(
    media: Media,
    settings: ReturnType<typeof getSettings>,
    is4k: boolean
  ): Promise<{ serviceId: number; externalServiceId: number } | null> {
    for (const server of settings.radarr) {
      if (server.is4k !== is4k) continue;

      const radarr = new RadarrAPI({
        apiKey: server.apiKey,
        url: RadarrAPI.buildUrl(server, '/api/v3'),
      });

      try {
        const movie = await radarr.getMovieByTmdbId(media.tmdbId);
        if (movie?.id) {
          logger.info(
            `Discovered movie in Radarr server "${server.name}" by TMDB ID`,
            {
              label: 'Media',
              tmdbId: media.tmdbId,
              radarrId: movie.id,
              serverId: server.id,
            }
          );
          return { serviceId: server.id, externalServiceId: movie.id };
        }
      } catch {
        // Movie not found on this server, try next
      }
    }
    return null;
  }

  private async discoverSeriesInSonarr(
    media: Media,
    settings: ReturnType<typeof getSettings>,
    is4k: boolean
  ): Promise<{ serviceId: number; externalServiceId: number } | null> {
    if (!media.tvdbId) return null;

    for (const server of settings.sonarr) {
      if (server.is4k !== is4k) continue;

      const sonarr = new SonarrAPI({
        apiKey: server.apiKey,
        url: SonarrAPI.buildUrl(server, '/api/v3'),
      });

      try {
        const series = await sonarr.getSeriesByTvdbId(media.tvdbId);
        if (series?.id) {
          logger.info(
            `Discovered series in Sonarr server "${server.name}" by TVDB ID`,
            {
              label: 'Media',
              tvdbId: media.tvdbId,
              sonarrId: series.id,
              serverId: server.id,
            }
          );
          return { serviceId: server.id, externalServiceId: series.id };
        }
      } catch {
        // Series not found on this server, try next
      }
    }
    return null;
  }

  private async ensureMovieMonitored(
    radarr: RadarrAPI,
    movie: RadarrMovie
  ): Promise<void> {
    if (!movie.monitored) {
      logger.info(
        'Movie is not monitored in Radarr, setting to monitored before re-download',
        { label: 'Media', movieId: movie.id }
      );
      await radarr.updateMovie({ ...movie, monitored: true });
    }
  }

  private async ensureSeriesMonitored(
    sonarr: SonarrAPI,
    seriesId: number,
    payload: RedownloadPayload
  ): Promise<void> {
    try {
      const series = await sonarr.getSeriesById(seriesId);
      const episodes = await sonarr.getEpisodes(seriesId);

      let seriesUpdated = !series.monitored;
      if (!series.monitored) {
        logger.info(
          'Series is not monitored in Sonarr, setting to monitored before re-download',
          { label: 'Media', seriesId }
        );
        series.monitored = true;
      }

      if (payload.seasons && payload.seasons.length > 0) {
        seriesUpdated =
          this.ensureSeasonsMonitored(series, payload.seasons, seriesId) ||
          seriesUpdated;
        await this.ensureEpisodesMonitoredBySeasons(
          sonarr,
          episodes,
          payload.seasons,
          seriesId
        );
      } else if (payload.episodes && payload.episodes.length > 0) {
        const sonarrEpisodeIds = this.resolveEpisodeIds(
          episodes,
          payload.episodes
        );
        const seasonNumbers = [
          ...new Set(payload.episodes.map((ep) => ep.seasonNumber)),
        ];
        seriesUpdated =
          this.ensureSeasonsMonitored(series, seasonNumbers, seriesId) ||
          seriesUpdated;
        await this.ensureEpisodesMonitoredByIds(
          sonarr,
          episodes,
          sonarrEpisodeIds,
          seriesId
        );
      } else {
        seriesUpdated =
          this.ensureAllSeasonsMonitored(series, seriesId) || seriesUpdated;
        await this.ensureAllEpisodesMonitored(sonarr, episodes, seriesId);
      }

      if (seriesUpdated) {
        await sonarr.updateSeries(series);
      }
    } catch (e) {
      logger.warn(
        'Could not verify/update monitoring status, continuing with search',
        { label: 'Media', errorMessage: e.message }
      );
    }
  }

  private ensureSeasonsMonitored(
    series: SonarrSeries,
    seasonNumbers: number[],
    seriesId: number
  ): boolean {
    let updated = false;
    for (const season of series.seasons) {
      if (seasonNumbers.includes(season.seasonNumber) && !season.monitored) {
        logger.info(
          'Season is not monitored in Sonarr, setting to monitored before re-download',
          { label: 'Media', seriesId, seasonNumber: season.seasonNumber }
        );
        season.monitored = true;
        updated = true;
      }
    }
    return updated;
  }

  private ensureAllSeasonsMonitored(
    series: SonarrSeries,
    seriesId: number
  ): boolean {
    let updated = false;
    for (const season of series.seasons) {
      if (season.seasonNumber > 0 && !season.monitored) {
        logger.info(
          'Season is not monitored in Sonarr, setting to monitored before re-download',
          { label: 'Media', seriesId, seasonNumber: season.seasonNumber }
        );
        season.monitored = true;
        updated = true;
      }
    }
    return updated;
  }

  private resolveEpisodeIds(
    sonarrEpisodes: EpisodeInfo[],
    episodes: { seasonNumber: number; episodeNumber: number }[]
  ): number[] {
    return episodes
      .map((ep) =>
        sonarrEpisodes.find(
          (se) =>
            se.seasonNumber === ep.seasonNumber &&
            se.episodeNumber === ep.episodeNumber
        )
      )
      .filter((ep): ep is EpisodeInfo => ep != null)
      .map((ep) => ep.id);
  }

  private async ensureEpisodesMonitoredBySeasons(
    sonarr: SonarrAPI,
    episodes: EpisodeInfo[],
    seasonNumbers: number[],
    seriesId: number
  ): Promise<void> {
    const unmonitoredIds = episodes
      .filter((ep) => seasonNumbers.includes(ep.seasonNumber) && !ep.monitored)
      .map((ep) => ep.id);

    if (unmonitoredIds.length > 0) {
      logger.info(
        'Episodes in target season(s) are not monitored, setting to monitored before re-download',
        { label: 'Media', seriesId, episodeCount: unmonitoredIds.length }
      );
      await sonarr.monitorEpisodes(unmonitoredIds, true);
    }
  }

  private async ensureEpisodesMonitoredByIds(
    sonarr: SonarrAPI,
    episodes: EpisodeInfo[],
    sonarrEpisodeIds: number[],
    seriesId: number
  ): Promise<void> {
    const unmonitoredIds = episodes
      .filter((ep) => sonarrEpisodeIds.includes(ep.id) && !ep.monitored)
      .map((ep) => ep.id);

    if (unmonitoredIds.length > 0) {
      logger.info(
        'Episodes are not monitored in Sonarr, setting to monitored before re-download',
        { label: 'Media', seriesId, episodeIds: unmonitoredIds }
      );
      await sonarr.monitorEpisodes(unmonitoredIds, true);
    }
  }

  private async ensureAllEpisodesMonitored(
    sonarr: SonarrAPI,
    episodes: EpisodeInfo[],
    seriesId: number
  ): Promise<void> {
    const unmonitoredIds = episodes
      .filter((ep) => ep.seasonNumber > 0 && !ep.monitored)
      .map((ep) => ep.id);

    if (unmonitoredIds.length > 0) {
      logger.info(
        'Episodes are not monitored in Sonarr, setting to monitored before re-download',
        { label: 'Media', seriesId, episodeCount: unmonitoredIds.length }
      );
      await sonarr.monitorEpisodes(unmonitoredIds, true);
    }
  }

  private async deleteExistingEpisodeFiles(
    sonarr: SonarrAPI,
    seriesId: number,
    payload: RedownloadPayload
  ): Promise<void> {
    try {
      const allFiles = await sonarr.getEpisodeFiles(seriesId);

      let filesToDelete: { id: number; seasonNumber: number }[];

      if (payload.seasons && payload.seasons.length > 0) {
        filesToDelete = allFiles.filter((f) =>
          payload.seasons!.includes(f.seasonNumber)
        );
      } else if (payload.episodes && payload.episodes.length > 0) {
        const episodes = await sonarr.getEpisodes(seriesId);
        const sonarrEpisodeIds = this.resolveEpisodeIds(
          episodes,
          payload.episodes
        );
        const targetFileIds = new Set(
          episodes
            .filter(
              (ep) => sonarrEpisodeIds.includes(ep.id) && ep.episodeFileId > 0
            )
            .map((ep) => ep.episodeFileId)
        );
        filesToDelete = allFiles.filter((f) => targetFileIds.has(f.id));
      } else {
        filesToDelete = allFiles;
      }

      const fileIds = filesToDelete.map((f) => f.id);

      if (fileIds.length > 0) {
        logger.info('Deleting existing episode files before re-download', {
          label: 'Media',
          seriesId,
          fileCount: fileIds.length,
        });
        await sonarr.deleteEpisodeFiles(fileIds);
      }
    } catch (e) {
      logger.warn(
        'Could not delete existing episode files, continuing with search',
        { label: 'Media', errorMessage: e.message }
      );
    }
  }

  private async searchSonarr(
    sonarr: SonarrAPI,
    seriesId: number,
    payload: RedownloadPayload
  ): Promise<{ success: boolean; message: string }> {
    if (payload.seasons && payload.seasons.length > 0) {
      for (const seasonNumber of payload.seasons) {
        await sonarr.searchSeason(seriesId, seasonNumber);
      }
      return {
        success: true,
        message: `Re-download initiated for ${payload.seasons.length} season(s).`,
      };
    }

    if (payload.episodes && payload.episodes.length > 0) {
      const episodes = await sonarr.getEpisodes(seriesId);
      const sonarrEpisodeIds = this.resolveEpisodeIds(
        episodes,
        payload.episodes
      );
      await sonarr.searchEpisodes(sonarrEpisodeIds);
      return {
        success: true,
        message: `Re-download initiated for ${payload.episodes.length} episode(s).`,
      };
    }

    await sonarr.searchSeries(seriesId);
    return { success: true, message: 'Series re-download initiated.' };
  }
}

export default RedownloadService;
