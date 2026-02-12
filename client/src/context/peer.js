import { create } from "zustand";

export const store = create((get, set) => ({
    peer: new RTCPeerConnection({
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
        ]
    }),
    createOffer: async() => {
        const offer = await get().peer.createOffer()
    },
    createAnswer: () => {

    },
    acceptOffer: () => {

    },
    acceptAnswer: () => {

    }

})) 