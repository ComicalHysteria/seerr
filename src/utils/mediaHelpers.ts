import { MediaStatus } from '@server/constants/media';

export const isMediaAvailable = (
  status?: MediaStatus,
  includePartial = false
): boolean => {
  if (status === MediaStatus.AVAILABLE) return true;
  if (includePartial && status === MediaStatus.PARTIALLY_AVAILABLE) return true;
  return false;
};
