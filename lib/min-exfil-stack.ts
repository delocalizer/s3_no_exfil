import * as cdk from 'aws-cdk-lib';
import { Stack, StackProps, Duration, RemovalPolicy, CfnOutput, Aws, Fn } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';

export class MinExfilStack extends Stack {
  constructor(scope: cdk.App, id: string, props?: StackProps) {
    super(scope, id, props);

    // ---------- PARAMETERS / CONFIG ----------
    const bucketName = `protected-${Aws.ACCOUNT_ID}-${Aws.REGION}`;
    const dataPrefix = 'datasets/'; // constrain read to this prefix inside the bucket
    const launchExampleEc2 = true;  // flip to false if you don't want an example instance

    // ---------- VPC: only isolated subnets (no NAT, no IGW) ----------
    const vpc = new ec2.Vpc(this, 'NoEgressVpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        {
          name: 'Isolated',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED, // no route to NAT/IGW
          cidrMask: 24,
        },
      ],
    });
    // There are no public subnets -> CDK won’t create an IGW. No NAT as above.

    // ---------- S3 bucket with strong posture ----------
    const bucket = new s3.Bucket(this, 'ProtectedBucket', {
      bucketName,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: RemovalPolicy.RETAIN,
      autoDeleteObjects: false,
    });

    // ---------- Gateway VPC Endpoint for S3 ----------
    const s3Endpoint = vpc.addGatewayEndpoint('S3GatewayEndpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
      // Attach to all isolated route tables
      subnets: [{ subnets: vpc.isolatedSubnets }],
      // Narrow to this bucket/prefix at the endpoint policy (defense-in-depth)
      // Note: Gateway endpoint policies are resource policies on the endpoint.
      // This allows S3 traffic only to the intended bucket/prefix.
      // (Bucket policy below separately enforces the 'via VPCE' requirement.)
      policy: new iam.PolicyDocument({
        statements: [
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['s3:GetObject', 's3:ListBucket'],
            resources: [
              bucket.bucketArn,
              `${bucket.bucketArn}/${dataPrefix}*`,
            ],
            principals: [new iam.AnyPrincipal()],
          }),
        ],
      }),
    });

    // ---------- Compute role: for BOTH EC2 & Batch (ecs-tasks) ----------
    const computeRole = new iam.Role(this, 'ComputeDataAccessRole', {
      roleName: 'ComputeDataAccessRole',
      description: 'Compute role allowed to read the protected S3 prefix via the S3 VPC Endpoint',
      assumedBy: new iam.CompositePrincipal(
        new iam.ServicePrincipal('ec2.amazonaws.com'),
        new iam.ServicePrincipal('ecs-tasks.amazonaws.com') // AWS Batch job role
      ),
      // (Optional) add managed policies you need for logs/ssm, etc., if you later add interface endpoints
      // managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('CloudWatchLogsFullAccess')],
    });

    // Allow the role to list bucket and get objects for the prefix
    computeRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['s3:ListBucket'],
      resources: [bucket.bucketArn],
      conditions: {
        'StringLike': { 's3:prefix': [`${dataPrefix}*`] },
      },
    }));
    computeRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['s3:GetObject'],
      resources: [`${bucket.bucketArn}/${dataPrefix}*`],
    }));

    // ---------- Bucket Policy: enforce VPCE & compute-role-only ----------
    // Deny if NOT via this VPCE
    bucket.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'DenyIfNotFromS3VPCE',
      effect: iam.Effect.DENY,
      principals: [new iam.AnyPrincipal()],
      actions: ['s3:GetObject', 's3:ListBucket'],
      resources: [bucket.bucketArn, `${bucket.bucketArn}/*`],
      conditions: {
        StringNotEquals: {
          // aws:SourceVpce must equal this endpoint ID
          'aws:SourceVpce': s3Endpoint.vpcEndpointId,
        },
      },
    }));

    // Deny if principal is NOT the compute role (assumed-role)
    // Matches STS assumed-role ARN: arn:aws:sts::<acct>:assumed-role/ComputeDataAccessRole/<session>
    bucket.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'DenyIfNotComputeRole',
      effect: iam.Effect.DENY,
      principals: [new iam.AnyPrincipal()],
      actions: ['s3:GetObject', 's3:ListBucket'],
      resources: [bucket.bucketArn, `${bucket.bucketArn}/*`],
      conditions: {
        StringNotLike: {
          'aws:PrincipalArn': [
            `arn:aws:sts::*:assumed-role/${computeRole.roleName}/*`,
          ],
        },
      },
    }));

    // TLS / SSL already enforced by enforceSSL, but an explicit Deny shows intent
    bucket.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'DenyInsecureTransport',
      effect: iam.Effect.DENY,
      principals: [new iam.AnyPrincipal()],
      actions: ['s3:*'],
      resources: [bucket.bucketArn, `${bucket.bucketArn}/*`],
      conditions: { Bool: { 'aws:SecureTransport': 'false' } },
    }));

    // ---------- (Optional) example EC2 instance in the isolated subnets ----------
    // This is just to demonstrate attaching the role and no-egress SG.
    // Remove if you don't need a sample instance.
    if (launchExampleEc2) {
      const sgNoEgress = new ec2.SecurityGroup(this, 'ComputeNoEgressSg', {
        vpc,
        description: 'No outbound; inbound from VPC only (adjust as needed)',
        allowAllOutbound: false, // deny all egress
      });
      // (optional) allow specific east-west traffic if you have a scheduler/jumpbox, etc.
      // sgNoEgress.addIngressRule(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.allTraffic());

      const instance = new ec2.Instance(this, 'ExampleEc2', {
        vpc,
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
        instanceType: new ec2.InstanceType('t3.micro'),
        machineImage: ec2.MachineImage.latestAmazonLinux2023(),
        role: computeRole,             // attaches instance profile automatically
        securityGroup: sgNoEgress,
        detailedMonitoring: false,
      });

      // Harden IMDS (IMDSv2 required)
      const cfnInst = instance.node.defaultChild as ec2.CfnInstance;
      cfnInst.addPropertyOverride('MetadataOptions', {
        HttpTokens: 'required',
        HttpEndpoint: 'enabled',
        HttpPutResponseHopLimit: 1,
      });
    }

    // ---------- Outputs ----------
    new CfnOutput(this, 'VpcId', { value: vpc.vpcId });
    new CfnOutput(this, 'S3GatewayEndpointId', { value: s3Endpoint.vpcEndpointId });
    new CfnOutput(this, 'BucketName', { value: bucket.bucketName });
    new CfnOutput(this, 'ComputeRoleArn', { value: computeRole.roleArn });
    new CfnOutput(this, 'DataPrefix', { value: dataPrefix });
  }
}

