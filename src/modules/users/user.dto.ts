import type { Types } from 'mongoose';

export interface UserDto {
  id: string;
  email: string;
  displayName: string;
  createdAt: string;
}

export function toUserDto(user: {
  _id: Types.ObjectId;
  email: string;
  displayName: string;
  createdAt: Date;
}): UserDto {
  return {
    id: user._id.toString(),
    email: user.email,
    displayName: user.displayName,
    createdAt: user.createdAt.toISOString(),
  };
}
