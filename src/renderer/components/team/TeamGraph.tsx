import React, { useMemo } from 'react';
import type { Team, AgentProvider, AgentStatus } from '../../../shared/types';
import { PROVIDER_META } from '../../../shared/constants';

interface Props {
  team: Team;
}

const SVG_SIZE = 400;
const CENTER = SVG_SIZE / 2;
const RADIUS = 140;
const NODE_RADIUS = 28;

function statusBorderColor(status?: AgentStatus): string {
  if (!status) return '#6B7280'; // gray-500
  switch (status) {
    case 'working':
      return '#22C55E'; // green
    case 'idle':
    case 'waiting':
      return '#6B7280'; // gray
    case 'crashed':
      return '#EF4444'; // red
    case 'launching':
    case 'restarting':
      return '#F59E0B'; // amber
    case 'done':
      return '#3B82F6'; // blue
    default:
      return '#6B7280';
  }
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '\u2026';
}

export default function TeamGraph({ team }: Props) {
  const members = team.members ?? [];
  const channels = team.channels ?? [];

  // Compute node positions in a circle
  const nodePositions = useMemo(() => {
    const positions: Record<string, { x: number; y: number }> = {};
    const count = members.length;
    if (count === 0) return positions;

    members.forEach((member, i) => {
      const angle = (2 * Math.PI * i) / count - Math.PI / 2;
      positions[member.agentId] = {
        x: CENTER + RADIUS * Math.cos(angle),
        y: CENTER + RADIUS * Math.sin(angle),
      };
    });
    return positions;
  }, [members]);

  // Build a lookup for quick member info
  const memberMap = useMemo(() => {
    const map: Record<string, (typeof members)[0]> = {};
    for (const m of members) map[m.agentId] = m;
    return map;
  }, [members]);

  if (members.length === 0) {
    return (
      <div className="flex items-center justify-center h-64 text-gray-500 text-sm">
        No members in this team.
      </div>
    );
  }

  return (
    <div className="flex items-center justify-center p-4">
      <svg
        width={SVG_SIZE}
        height={SVG_SIZE}
        viewBox={`0 0 ${SVG_SIZE} ${SVG_SIZE}`}
        className="overflow-visible"
      >
        <defs>
          <marker
            id="arrowhead"
            markerWidth="8"
            markerHeight="6"
            refX="8"
            refY="3"
            orient="auto"
            markerUnits="strokeWidth"
          >
            <path d="M0,0 L8,3 L0,6 Z" fill="#6B7280" />
          </marker>
        </defs>

        {/* Edges */}
        {channels.map((ch) => {
          const from = nodePositions[ch.fromAgent];
          const to = nodePositions[ch.toAgent];
          if (!from || !to) return null;

          // Shorten the line so it doesn't overlap the node circle
          const dx = to.x - from.x;
          const dy = to.y - from.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist === 0) return null;

          const ux = dx / dist;
          const uy = dy / dist;
          const startX = from.x + ux * (NODE_RADIUS + 4);
          const startY = from.y + uy * (NODE_RADIUS + 4);
          const endX = to.x - ux * (NODE_RADIUS + 10);
          const endY = to.y - uy * (NODE_RADIUS + 10);

          // Slight curve offset for bidirectional edges
          const hasReverse = channels.some(
            (c) => c.fromAgent === ch.toAgent && c.toAgent === ch.fromAgent
          );
          let midX = (startX + endX) / 2;
          let midY = (startY + endY) / 2;
          if (hasReverse) {
            const perpX = -uy * 18;
            const perpY = ux * 18;
            midX += perpX;
            midY += perpY;
          }

          return (
            <path
              key={ch.id}
              d={`M ${startX},${startY} Q ${midX},${midY} ${endX},${endY}`}
              fill="none"
              stroke="#4B5563"
              strokeWidth="1.5"
              markerEnd="url(#arrowhead)"
            />
          );
        })}

        {/* Nodes */}
        {members.map((member) => {
          const pos = nodePositions[member.agentId];
          if (!pos) return null;

          const provider = (member.provider ?? 'claude') as AgentProvider;
          const meta = PROVIDER_META[provider] ?? PROVIDER_META.claude;
          const borderColor = statusBorderColor(member.status);
          const label = truncate(member.title ?? member.agentId.slice(0, 8), 10);

          return (
            <g key={member.agentId}>
              {/* Status ring */}
              <circle
                cx={pos.x}
                cy={pos.y}
                r={NODE_RADIUS + 3}
                fill="none"
                stroke={borderColor}
                strokeWidth="2.5"
                opacity={0.7}
              />
              {/* Node circle */}
              <circle
                cx={pos.x}
                cy={pos.y}
                r={NODE_RADIUS}
                fill={meta.color + '33'}
                stroke={meta.color}
                strokeWidth="2"
              />
              {/* Label */}
              <text
                x={pos.x}
                y={pos.y + 1}
                textAnchor="middle"
                dominantBaseline="middle"
                fill="white"
                fontSize="11"
                fontWeight="500"
              >
                {label}
              </text>
              {/* Role subtitle */}
              {member.role && (
                <text
                  x={pos.x}
                  y={pos.y + NODE_RADIUS + 16}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fill="#9CA3AF"
                  fontSize="10"
                >
                  {truncate(member.role, 14)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
