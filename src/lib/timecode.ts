import type { FrameRate } from "./contracts";

export function framesToTimecode(frames: number, rate: FrameRate): string {
  const fps = rate.numerator / rate.denominator;
  const nominalFps = Math.round(fps);

  if (!rate.dropFrame) {
    const totalSeconds = Math.floor(frames / nominalFps);
    const framePart = frames % nominalFps;
    const seconds = totalSeconds % 60;
    const minutes = Math.floor(totalSeconds / 60) % 60;
    const hours = Math.floor(totalSeconds / 3600);
    return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}:${pad(framePart)}`;
  }

  const dropFrames = Math.round(nominalFps * 0.066666);
  const framesPerHour = nominalFps * 60 * 60;
  const framesPer24Hours = framesPerHour * 24;
  const framesPer10Minutes = nominalFps * 60 * 10 - dropFrames * 9;
  const framesPerMinute = nominalFps * 60 - dropFrames;
  let adjusted = frames % framesPer24Hours;
  const tenMinuteBlocks = Math.floor(adjusted / framesPer10Minutes);
  const remainder = adjusted % framesPer10Minutes;
  adjusted += dropFrames * 9 * tenMinuteBlocks;
  if (remainder >= dropFrames) {
    adjusted += dropFrames * Math.floor((remainder - dropFrames) / framesPerMinute);
  }

  const framePart = adjusted % nominalFps;
  const totalSeconds = Math.floor(adjusted / nominalFps);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)};${pad(framePart)}`;
}

export function clipTimecode(
  clipOffsetMs: number,
  rate: FrameRate,
  startTimecodeFrames: number | null,
): string {
  const offsetFrames = Math.round(
    (clipOffsetMs / 1000) * (rate.numerator / rate.denominator),
  );
  return framesToTimecode((startTimecodeFrames ?? 0) + offsetFrames, rate);
}

function pad(value: number): string {
  return Math.floor(value).toString().padStart(2, "0");
}

