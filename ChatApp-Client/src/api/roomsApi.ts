import { api } from './baseApi';
import type { ListRoomsResponse } from '../generated/rest/list-rooms.response';
import type { CreateRoomRequest } from '../generated/rest/create-room.request';
import type { CreateRoomResponse } from '../generated/rest/create-room.response';
import type { AddRoomMemberRequest } from '../generated/rest/add-room-member.request';
import type { AddRoomMemberResponse } from '../generated/rest/add-room-member.response';

export const roomsApi = api.injectEndpoints({
  endpoints: (build) => ({
    listRooms: build.query<ListRoomsResponse, void>({
      query: () => '/rooms',
      providesTags: ['Room'],
    }),
    createRoom: build.mutation<CreateRoomResponse, CreateRoomRequest>({
      query: (body) => ({ url: '/rooms', method: 'POST', body }),
      invalidatesTags: ['Room'],
    }),
    addRoomMember: build.mutation<AddRoomMemberResponse, { roomId: string } & AddRoomMemberRequest>(
      {
        query: ({ roomId, ...body }) => ({
          url: `/rooms/${roomId}/members`,
          method: 'POST',
          body,
        }),
        invalidatesTags: ['Room'],
      },
    ),
  }),
});

export const { useListRoomsQuery, useCreateRoomMutation, useAddRoomMemberMutation } = roomsApi;
