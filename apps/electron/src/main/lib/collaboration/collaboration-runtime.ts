import type { CollaborationRoomService } from "./collaboration-room-service";

let registeredCollaborationRoomService: CollaborationRoomService | null = null;

export function setRegisteredCollaborationRoomService(
  service: CollaborationRoomService | null,
): void {
  registeredCollaborationRoomService = service;
}

export function getRegisteredCollaborationRoomService(): CollaborationRoomService | null {
  return registeredCollaborationRoomService;
}
