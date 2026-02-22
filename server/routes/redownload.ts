import { Permission } from '@server/lib/permissions';
import RedownloadService, {
  RedownloadError,
  type RedownloadPayload,
} from '@server/lib/redownload';
import logger from '@server/logger';
import { isAuthenticated } from '@server/middleware/auth';
import { Router } from 'express';

const redownloadRoutes = Router();
const redownloadService = new RedownloadService();

redownloadRoutes.post<
  { mediaId: string },
  { success: boolean; message: string },
  RedownloadPayload
>(
  '/:mediaId',
  isAuthenticated(Permission.RE_DOWNLOAD),
  async (req, res, next) => {
    try {
      const response = await redownloadService.redownload(
        Number(req.params.mediaId),
        req.body
      );

      return res.status(200).json(response);
    } catch (e) {
      if (e instanceof RedownloadError) {
        return next({ status: e.status, message: e.message });
      }

      logger.error('Something went wrong initiating re-download', {
        label: 'Media',
        message: e.message,
      });
      return next({ status: 500, message: 'Failed to initiate re-download.' });
    }
  }
);

export default redownloadRoutes;
